import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fakeClaudeSource = String.raw`
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const supportsDefer = process.env.FAKE_CLAUDE_SUPPORTS_DEFER === 'true';
const initialDelayMs = Number(process.env.FAKE_CLAUDE_INITIAL_DELAY_MS ?? 0);
const resumeDelayMs = Number(process.env.FAKE_CLAUDE_RESUME_DELAY_MS ?? 0);
const initialToolUseId = process.env.FAKE_CLAUDE_INITIAL_TOOL_USE_ID || 'toolu_fixture';
const deferredToolUseId = process.env.FAKE_CLAUDE_DEFERRED_TOOL_USE_ID || initialToolUseId;
const statePath = path.join(process.cwd(), 'fake-claude-state.json');
const markerPath = process.env.PI_CONTROL_PROBE_MARKER;
const hookPath = process.env.PI_CONTROL_PROBE_HOOK;
const settingsPath = path.join(process.cwd(), '.claude', 'settings.json');

function result(value) {
  process.stdout.write(JSON.stringify(value));
}

function delay(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runHook(toolUseId, toolInput) {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const hook = settings.hooks?.PreToolUse?.find((entry) => entry.matcher === 'Bash')?.hooks?.[0];
  if (hook?.type !== 'command' || !hook.command.includes(hookPath)) {
    throw new Error('expected temporary Bash PreToolUse hook');
  }
  const hookRun = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ tool_name: 'Bash', tool_use_id: toolUseId, tool_input: toolInput }),
    encoding: 'utf8',
    env: process.env,
  });
  if (hookRun.status !== 0) throw new Error('hook failed');
  return JSON.parse(hookRun.stdout).hookSpecificOutput.permissionDecision;
}

try {
  if (!args.includes('-p') || !args.includes('--output-format') || !args.includes('json')) {
    throw new Error('expected print mode and JSON output');
  }
  const resumeAt = args.indexOf('--resume');
  if (resumeAt >= 0) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (args[resumeAt + 1] !== state.sessionId) throw new Error('resumed wrong session');
    delay(resumeDelayMs);
    const resumeToolUseId = process.env.FAKE_CLAUDE_RESUME_TOOL_USE_ID || state.toolUseId;
    const resumeToolInput = process.env.FAKE_CLAUDE_RESUME_TOOL_INPUT
      ? JSON.parse(process.env.FAKE_CLAUDE_RESUME_TOOL_INPUT)
      : state.toolInput;
    if (runHook(resumeToolUseId, resumeToolInput) !== 'allow') throw new Error('expected hook to allow resume');
    if (!markerPath) throw new Error('missing marker path');
    writeFileSync(markerPath, 'executed\n', { flag: 'a' });
    result({ type: 'result', subtype: 'success', stop_reason: 'end_turn', session_id: state.sessionId });
  } else {
    const prompt = args[args.indexOf('-p') + 1];
    const expectedCommand = prompt.match(/Run this exact harmless command exactly once: (.+?) After the command succeeds/)[1];
    const toolInput = { command: expectedCommand };
    delay(initialDelayMs);
    const decision = runHook(initialToolUseId, toolInput);
    if (!supportsDefer || decision !== 'defer') {
      result({ type: 'result', subtype: 'success', stop_reason: 'end_turn', session_id: 'fixture-session' });
    } else {
      const sessionId = 'fixture-session';
      writeFileSync(statePath, JSON.stringify({ sessionId, toolUseId: initialToolUseId, toolInput }));
      result({
        type: 'result',
        subtype: 'success',
        stop_reason: 'tool_deferred',
        session_id: sessionId,
        deferred_tool_use: { id: deferredToolUseId, name: 'Bash', input: toolInput },
      });
    }
  }
} catch (error) {
  process.stderr.write(String(error.message));
  process.exitCode = 2;
}
`;

export async function createCapabilityFixture({
  supportsDefer,
  initialDelayMs = 0,
  resumeDelayMs = 0,
  resumeToolUseId = '',
  deferredToolUseId = '',
  resumeToolInput = undefined,
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-claude-capability-'));
  const script = path.join(dir, 'fake-claude.mjs');
  await writeFile(script, fakeClaudeSource, 'utf8');

  let bin = path.join(dir, 'fake-claude');
  if (process.platform === 'win32') {
    bin = path.join(dir, 'fake-claude.cmd');
    await writeFile(bin, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude.mjs" %*\r\n`, 'utf8');
  } else {
    await writeFile(bin, `#!/usr/bin/env node\nimport './fake-claude.mjs';\n`, 'utf8');
    await chmod(bin, 0o755);
  }

  return Object.freeze({
    bin,
    dir,
    env: Object.freeze({
      FAKE_CLAUDE_SUPPORTS_DEFER: String(supportsDefer),
      FAKE_CLAUDE_INITIAL_DELAY_MS: String(initialDelayMs),
      FAKE_CLAUDE_RESUME_DELAY_MS: String(resumeDelayMs),
      FAKE_CLAUDE_RESUME_TOOL_USE_ID: resumeToolUseId,
      FAKE_CLAUDE_DEFERRED_TOOL_USE_ID: deferredToolUseId,
      FAKE_CLAUDE_RESUME_TOOL_INPUT: resumeToolInput === undefined ? '' : JSON.stringify(resumeToolInput),
    }),
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  });
}
