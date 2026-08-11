#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { isMainModule } from '../src/shared/main-module.js';

const BLOCK_MESSAGE = 'Tool use blocked because local risk verification failed.';

function valid(value) {
  return typeof value === 'string' && value.length > 0;
}

async function keyFromEnvironment(env) {
  if (valid(env.PI_CLAUDE_HOOK_KEY)) return env.PI_CLAUDE_HOOK_KEY;
  if (valid(env.PI_CLAUDE_HOOK_KEY_FILE)) return (await readFile(env.PI_CLAUDE_HOOK_KEY_FILE, 'utf8')).trim();
  return '';
}

export async function hookMain({
  stdin,
  env = process.env,
  fetch = globalThis.fetch,
  timeoutMs = 10_000,
} = {}) {
  const fail = () => ({ code: 2, stdout: '', stderr: BLOCK_MESSAGE });
  try {
    const input = JSON.parse(stdin);
    const taskId = env.PI_CLAUDE_TASK_ID;
    const coreUrl = env.PI_CLAUDE_CORE_URL;
    const key = await keyFromEnvironment(env);
    if (!valid(taskId) || coreUrl !== 'http://127.0.0.1:4330' || !valid(key)
      || !valid(input.session_id) || !valid(input.tool_name) || !valid(input.tool_use_id)
      || !input.tool_input || typeof input.tool_input !== 'object' || Array.isArray(input.tool_input)) return fail();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('hook request timeout')), timeoutMs);
    let response;
    try {
      response = await fetch(`${coreUrl}/v1/hooks/pre-tool-use`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pi-Control-Key': key },
        body: JSON.stringify({
          sessionId: input.session_id,
          taskId,
          toolName: input.tool_name,
          toolInput: input.tool_input,
          toolUseId: input.tool_use_id,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (response.status !== 200) return fail();
    const parsed = JSON.parse(await response.text());
    const hookOutput = parsed?.data?.hookSpecificOutput;
    if (hookOutput?.hookEventName !== 'PreToolUse' || !['allow', 'defer', 'deny'].includes(hookOutput.permissionDecision)) return fail();
    return { code: 0, stdout: JSON.stringify({ hookSpecificOutput: hookOutput }), stderr: '' };
  } catch {
    return fail();
  }
}

async function readStdin() {
  let value = '';
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, 'utf8') > 1024 * 1024) throw new Error('hook input too large');
  }
  return value;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const result = await hookMain({ stdin: await readStdin().catch(() => '') });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
