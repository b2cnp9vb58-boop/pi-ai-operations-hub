#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
function fakeOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const capture = fakeOption('--fake-capture');
if (capture) writeFileSync(capture, JSON.stringify({ args, env: process.env }));

const sessionIndex = args.indexOf('--session-id');
const resumeIndex = args.indexOf('--resume');
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : args[sessionIndex + 1];

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (args.includes('--fake-ignore-sigterm')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else if (args.includes('--fake-hang')) {
  setInterval(() => {}, 1_000);
} else {
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  if (args.includes('--fake-malformed')) process.stdout.write('{malformed\n');
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial ' } } });
  emit({ type: 'assistant', message: { content: [
    { type: 'text', text: 'answer' },
    { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'true' } },
  ] } });
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: fakeOption('--fake-tool-output') ?? 'ok' }] } });
  emit({ type: 'result', subtype: 'success', session_id: sessionId, result: 'final answer', usage: { input_tokens: 7, output_tokens: 3 }, stop_reason: 'end_turn' });
}
