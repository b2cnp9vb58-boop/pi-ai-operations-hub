import { spawn } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from '../src/shared/main-module.js';

const PROBE_MARKER_TEXT = 'executed';
const DEFAULT_INITIAL_TIMEOUT_MS = 30000;
const DEFAULT_RESUME_TIMEOUT_MS = 30000;

function quoteForPosixShell(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function quoteForWindowsCommand(value) {
  return `"${value.replaceAll('"', '\\"')}"`;
}

function terminateSubprocess(child) {
  if (process.platform === 'win32') {
    const taskkill = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    taskkill.on('error', () => child.kill('SIGKILL'));
    return;
  }
  child.kill('SIGKILL');
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const { timeoutMs, ...spawnOptions } = options;
    const isWindowsCommandScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const child = isWindowsCommandScript
      ? spawn(process.env.ComSpec ?? 'cmd.exe', [
        '/d',
        '/c',
        `call ${quoteForWindowsCommand(command)} ${args.map(quoteForWindowsCommand).join(' ')}`,
      ], { ...spawnOptions, shell: false, windowsVerbatimArguments: true })
      : spawn(command, args, { ...spawnOptions, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateSubprocess(child);
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function probeTimeout(name, defaultValue) {
  const timeoutMs = Number(process.env[name] ?? defaultValue);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) return defaultValue;
  return timeoutMs;
}

function parseResult(stdout) {
  const candidates = [stdout.trim(), ...stdout.trim().split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed.type === 'result' || parsed.stop_reason) return parsed;
    } catch {
      // Claude can emit diagnostic lines before a JSON result. Keep looking.
    }
  }
  return undefined;
}

function failure(reason, failureCode = undefined) {
  return Object.freeze({
    compatible: false,
    reason,
    ...(failureCode === undefined ? {} : { failureCode }),
  });
}

async function writeProbeHook(probeDir) {
  const hookPath = path.join(probeDir, 'pre-tool-use.mjs');
  await writeFile(hookPath, `
import { readFile, writeFile } from 'node:fs/promises';

let payload = '';
for await (const chunk of process.stdin) payload += chunk;
const input = JSON.parse(payload);
const phase = process.env.PI_CONTROL_PROBE_PHASE;
const statePath = process.env.PI_CONTROL_PROBE_HOOK_STATE;
let captures = {};
try {
  captures = JSON.parse(await readFile(statePath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
captures[phase] = { toolUseId: input.tool_use_id, toolInput: input.tool_input };
await writeFile(statePath, JSON.stringify(captures), 'utf8');
const permissionDecision = phase === 'resume' ? 'allow' : 'defer';
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision,
  },
}));
`, 'utf8');
  return hookPath;
}

async function readHookCapture(statePath, phase) {
  const captures = JSON.parse(await readFile(statePath, 'utf8'));
  return captures[phase];
}

async function writeProbeSettings(probeDir, hookPath) {
  const settingsDir = path.join(probeDir, '.claude');
  await mkdir(settingsDir, { recursive: true });
  await writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `${quoteForPosixShell(process.execPath)} ${quoteForPosixShell(hookPath)}` }],
      }],
    },
  }), 'utf8');
}

export async function probeClaudeCapabilities(claudeBin, fixtureDir = undefined) {
  const probeDir = await mkdtemp(path.join(os.tmpdir(), 'pi-control-claude-probe-'));
  const cwd = fixtureDir ?? probeDir;
  const markerPath = path.join(probeDir, 'tool-executed.txt');
  const hookStatePath = path.join(probeDir, 'hook-state.json');
  const command = `printf '${PROBE_MARKER_TEXT}\\n' >> ${quoteForPosixShell(markerPath)}`;
  const prompt = [
    'Use exactly one Bash tool call and no other tool calls.',
    `Run this exact harmless command exactly once: ${command}`,
    'After the command succeeds, answer only COMPLETE.',
  ].join(' ');

  try {
    const hookPath = await writeProbeHook(cwd);
    await writeProbeSettings(cwd, hookPath);
    const baseEnv = {
      ...process.env,
      PI_CONTROL_PROBE_HOOK: hookPath,
      PI_CONTROL_PROBE_MARKER: markerPath,
      PI_CONTROL_PROBE_HOOK_STATE: hookStatePath,
    };
    const first = await run(claudeBin, ['-p', prompt, '--output-format', 'json'], {
      cwd,
      env: { ...baseEnv, PI_CONTROL_PROBE_PHASE: 'defer' },
      timeoutMs: probeTimeout('PI_CONTROL_PROBE_INITIAL_TIMEOUT_MS', DEFAULT_INITIAL_TIMEOUT_MS),
    });
    if (first.timedOut) return failure('initial subprocess timed out', 'initial_timeout');
    if (first.exitCode !== 0) return failure(`initial subprocess exited with ${first.exitCode ?? first.signal}`);

    const deferred = parseResult(first.stdout);
    if (deferred?.stop_reason !== 'tool_deferred') {
      return failure(`expected stop_reason tool_deferred, got ${String(deferred?.stop_reason)}`);
    }
    if (deferred.deferred_tool_use?.name !== 'Bash' || deferred.deferred_tool_use?.input?.command !== command) {
      return failure('tool_deferred result did not preserve the expected Bash tool call');
    }
    if (typeof deferred.deferred_tool_use?.id !== 'string' || deferred.deferred_tool_use.id.length === 0) {
      return failure('tool_deferred result did not provide a tool use ID');
    }
    if (typeof deferred.session_id !== 'string' || deferred.session_id.length === 0) {
      return failure('tool_deferred result did not provide a session_id');
    }
    const initialHook = await readHookCapture(hookStatePath, 'defer');
    if (initialHook?.toolUseId !== deferred.deferred_tool_use.id
      || !isDeepStrictEqual(initialHook?.toolInput, deferred.deferred_tool_use.input)) {
      return failure('initial PreToolUse payload did not match deferred tool use');
    }

    const resumed = await run(claudeBin, ['-p', '--resume', deferred.session_id, '--output-format', 'json'], {
      cwd,
      env: { ...baseEnv, PI_CONTROL_PROBE_PHASE: 'resume' },
      timeoutMs: probeTimeout('PI_CONTROL_PROBE_RESUME_TIMEOUT_MS', DEFAULT_RESUME_TIMEOUT_MS),
    });
    if (resumed.timedOut) return failure('resume subprocess timed out', 'resume_timeout');
    if (resumed.exitCode !== 0) return failure(`resume subprocess exited with ${resumed.exitCode ?? resumed.signal}`);

    const completed = parseResult(resumed.stdout);
    if (!completed || completed.stop_reason === 'tool_deferred') {
      return failure('resumed session did not complete the deferred tool call');
    }
    if (completed.stop_reason !== 'end_turn') {
      return failure(`resumed session ended with ${String(completed.stop_reason)}, not end_turn`);
    }
    const resumedHook = await readHookCapture(hookStatePath, 'resume');
    if (resumedHook?.toolUseId !== deferred.deferred_tool_use.id
      || !isDeepStrictEqual(resumedHook?.toolInput, deferred.deferred_tool_use.input)) {
      return failure('resumed PreToolUse payload did not match deferred tool use');
    }

    const markerLines = (await readFile(markerPath, 'utf8')).trim().split(/\r?\n/);
    if (markerLines.length !== 1 || markerLines[0] !== PROBE_MARKER_TEXT) {
      return failure('resumed tool call did not execute exactly once');
    }

    return Object.freeze({ compatible: true, toolExecutionCount: 1 });
  } catch (error) {
    return failure(`probe failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const [claudeBin] = process.argv.slice(2);
  if (!claudeBin) {
    console.error('usage: node scripts/probe-claude-capabilities.mjs /absolute/path/to/claude');
    process.exitCode = 2;
  } else {
    const report = await probeClaudeCapabilities(claudeBin);
    console.log(JSON.stringify(report));
    if (!report.compatible) process.exitCode = 1;
  }
}
