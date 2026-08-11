import assert from 'node:assert/strict';
import test from 'node:test';
import { hookMain } from '../bin/claude-pretool-hook.mjs';
import { analyzeToolBatch } from '../src/core/claude-runner.js';
import { approvalOptions } from '../src/telegram/progress.js';

test('hook CLI fails closed with exit 2 on parse, authentication, connection and timeout failures', async () => {
  for (const run of [
    () => hookMain({ stdin: '{', env: {} }),
    () => hookMain({ stdin: '{}', env: { PI_CLAUDE_TASK_ID: 't', PI_CLAUDE_HOOK_KEY: 'k' } }),
    () => hookMain({
      stdin: JSON.stringify({ session_id: 's', tool_name: 'Read', tool_input: {}, tool_use_id: 'u' }),
      env: { PI_CLAUDE_TASK_ID: 't', PI_CLAUDE_HOOK_KEY: 'k', PI_CLAUDE_CORE_URL: 'http://127.0.0.1:1' },
      fetch: async () => { throw new Error('connection refused'); },
    }),
  ]) assert.equal((await run()).code, 2);
});

test('hook prints only structured Claude output after an authenticated core decision', async () => {
  const result = await hookMain({
    stdin: JSON.stringify({ session_id: 's', tool_name: 'Read', tool_input: { file_path: '/var/log/x' }, tool_use_id: 'u' }),
    env: { PI_CLAUDE_TASK_ID: 't', PI_CLAUDE_HOOK_KEY: 'k', PI_CLAUDE_CORE_URL: 'http://127.0.0.1:4330' },
    fetch: async (_url, options) => {
      assert.equal(options.headers['X-Pi-Control-Key'], 'k');
      return { status: 200, text: async () => JSON.stringify({ data: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } } }) };
    },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
});

test('multi-tool batches are denied and instructed to retry one at a time', () => {
  assert.deepEqual(analyzeToolBatch([{ type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }]), {
    allowed: false,
    instruction: 'Retry using exactly one tool call at a time.',
  });
  assert.equal(analyzeToolBatch([{ type: 'tool_use', id: 'a' }]).allowed, true);
});

test('deployed settings match all tools with the absolute fail-closed hook', async () => {
  const settings = (await import('../config/claude-settings.json', { with: { type: 'json' } })).default;
  assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
  assert.equal(
    settings.hooks.PreToolUse[0].hooks[0].command,
    '/opt/node24/bin/node /opt/pi-ai-operations-hub/current/bin/claude-pretool-hook.mjs',
  );
});

test('approval card callbacks carry only the opaque approval id', () => {
  assert.deepEqual(approvalOptions('123e4567-e89b-12d3-a456-426614174000'), {
    reply_markup: { inline_keyboard: [[
      { text: '确认', callback_data: 'approve:123e4567-e89b-12d3-a456-426614174000' },
      { text: '取消', callback_data: 'cancel:123e4567-e89b-12d3-a456-426614174000' },
    ]] },
  });
});
