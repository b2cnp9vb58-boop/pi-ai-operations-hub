import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/database.js';
import { ConversationService } from '../src/core/conversation-service.js';
import { ClaudeRunner, buildClaudeEnv } from '../src/core/claude-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

function callbacks() {
  return { onAssistantText() {}, onToolStart() {}, onToolEnd() {}, onDeferred() {}, onError() {} };
}

function task(text, claudeSessionId) {
  return { id: `task-${text}`, text, claudeSessionId, channel: 'telegram' };
}

test('runner resumes the persisted Claude session id', async () => {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'pi-control-runner-'));
  try {
    const capture = join(directory, 'capture.json');
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: process.execPath, claudeCwd: process.cwd(), claudeSettings: '/tmp/settings.json' },
      spawnEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
      fixtureArgs: [fixture, '--fake-capture', capture],
    });
    const first = await runner.run(task('one'), { stableMemory: '', recentMessages: [], relevantMessages: [], summary: null }, callbacks());
    const second = await runner.run(task('two', first.sessionId), { stableMemory: '', recentMessages: [], relevantMessages: [], summary: null }, callbacks());

    assert.equal(second.sessionId, first.sessionId);
    const capturedArgs = JSON.parse(readFileSync(capture, 'utf8')).args;
    assert.equal(capturedArgs.includes('--resume'), true);
    assert.equal(capturedArgs.includes('--verbose'), true);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Claude child environment excludes control-plane secrets', () => {
  const env = buildClaudeEnv({
    PATH: '/usr/bin', HOME: '/home/pi-control', LANG: 'C.UTF-8', ANTHROPIC_API_KEY: 'provider-secret',
    TELEGRAM_BOT_TOKEN: 'bot-secret', PI_CONTROL_HOOK_KEY: 'hook-secret', PI_CONTROL_ADMIN_KEY: 'admin-secret',
    PI_CONTROL_DATABASE_PATH: '/private/database', PASSWORD_RECORD: 'private',
    AWS_SECRET_ACCESS_KEY: 'cloud-secret', CUSTOM_ADMIN_SECRET: 'custom-secret',
  });
  assert.equal(env.ANTHROPIC_API_KEY, 'provider-secret');
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.PI_CONTROL_HOOK_KEY, undefined);
  assert.equal(env.PI_CONTROL_ADMIN_KEY, undefined);
  assert.equal(env.PI_CONTROL_DATABASE_PATH, undefined);
  assert.equal(env.PASSWORD_RECORD, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.CUSTOM_ADMIN_SECRET, undefined);
  assert.throws(
    () => buildClaudeEnv({ AWS_SECRET_ACCESS_KEY: 'cloud-secret' }, ['AWS_SECRET_ACCESS_KEY']),
    /not an approved Claude provider key/,
  );
});

test('runner persists partial text and tool events while isolating malformed stream lines', async () => {
  const db = openDatabase(':memory:');
  try {
    const messages = [];
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: process.execPath, claudeCwd: process.cwd(), claudeSettings: '/tmp/settings.json' },
      spawnEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
      fixtureArgs: [fixture, '--fake-malformed'],
    });
    const result = await runner.run(task('stream'), { stableMemory: '', recentMessages: [], relevantMessages: [], summary: null }, {
      ...callbacks(), onAssistantText(text) { messages.push(text); },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.finalText, 'final answer');
    assert.deepEqual(messages, ['partial ', 'answer']);
    assert.ok(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE role = 'tool'").get().count >= 2);
  } finally {
    db.close();
  }
});

test('runner reports a timeout without leaving a child process running', async () => {
  const db = openDatabase(':memory:');
  try {
    let reported;
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: process.execPath, claudeCwd: process.cwd(), claudeSettings: '/tmp/settings.json' },
      spawnEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
      fixtureArgs: [fixture, '--fake-hang'], timeoutMs: 50,
    });
    const result = await runner.run(task('timeout'), { stableMemory: '', recentMessages: [], relevantMessages: [], summary: null }, {
      ...callbacks(), onError(error) { reported = error; },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.stopReason, 'timeout');
    assert.match(reported.message, /timed out/);
  } finally {
    db.close();
  }
});

test('oversized tool output is retained as a hashed attachment under the configured data directory', async () => {
  const db = openDatabase(':memory:');
  const directory = mkdtempSync(join(tmpdir(), 'pi-control-attachments-'));
  try {
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: {
        claudeBin: process.execPath, claudeCwd: process.cwd(), claudeSettings: '/tmp/settings.json', dataDir: directory,
      },
      spawnEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
      fixtureArgs: [fixture, '--fake-tool-output', 'x'.repeat(300)], maxToolOutputBytes: 256,
    });
    await runner.run(task('attachment'), { stableMemory: '', recentMessages: [], relevantMessages: [], summary: null }, callbacks());

    const attachment = db.prepare('SELECT stored_name, sha256, size_bytes FROM attachments').get();
    assert.match(attachment.stored_name, /^[a-f0-9]{64}\.tool-output\.txt$/);
    assert.equal(attachment.size_bytes, 300);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('timeout escalates to a hard kill when Claude ignores SIGTERM', async () => {
  const db = openDatabase(':memory:');
  let childPid;
  let safetyTimer;
  try {
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: process.execPath, claudeCwd: process.cwd(), claudeSettings: '/tmp/settings.json' },
      spawnEnv: { PATH: process.env.PATH, HOME: process.env.HOME },
      fixtureArgs: [fixture, '--fake-ignore-sigterm'], timeoutMs: 50, terminateGraceMs: 50,
      spawn(command, args, options) {
        const child = spawn(command, args, options);
        childPid = child.pid;
        return child;
      },
    });
    const startedAt = Date.now();
    safetyTimer = setTimeout(() => {
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }, 500);
    const result = await runner.run(task('stubborn-timeout'), {}, callbacks());
    assert.equal(result.stopReason, 'timeout');
    assert.ok(Date.now() - startedAt < 300, 'run must return within the bounded timeout grace');
    assert.throws(() => process.kill(childPid, 0), /ESRCH|no such process/i);
  } finally {
    clearTimeout(safetyTimer);
    try { process.kill(childPid, 'SIGKILL'); } catch {}
    db.close();
  }
});

test('timeout sends SIGKILL after grace even when SIGTERM produces no close event', async () => {
  const db = openDatabase(':memory:');
  const signals = [];
  let fakeChild;
  let safetyTimer;
  try {
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: '/fake/claude', claudeCwd: process.cwd(), claudeSettings: '/tmp/settings.json' },
      spawnEnv: { PATH: '/usr/bin', HOME: '/home/pi-control' },
      timeoutMs: 20,
      terminateGraceMs: 20,
      spawn() {
        fakeChild = new EventEmitter();
        fakeChild.stdout = new PassThrough();
        fakeChild.stderr = new PassThrough();
        fakeChild.kill = (signal) => {
          signals.push(signal);
          if (signal === 'SIGKILL') setImmediate(() => fakeChild.emit('close', null));
          return true;
        };
        return fakeChild;
      },
    });
    safetyTimer = setTimeout(() => fakeChild?.emit('close', null), 500);
    const startedAt = Date.now();
    const result = await runner.run(task('simulated-stubborn-timeout'), {}, callbacks());

    assert.equal(result.stopReason, 'timeout');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(Date.now() - startedAt < 200, 'hard-kill path must settle before the safety close');
  } finally {
    clearTimeout(safetyTimer);
    db.close();
  }
});

test('a two-tool assistant batch is terminated before either observable side effect', async () => {
  const db = openDatabase(':memory:');
  const sideEffects = [0, 0];
  const signals = [];
  const toolStarts = [];
  const batches = [];
  try {
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: '/fake/claude', claudeCwd: process.cwd(), claudeSettings: '/tmp/settings.json' },
      spawnEnv: { PATH: '/usr/bin', HOME: '/home/pi-control' },
      timeoutMs: 1000,
      spawn() {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = (signal) => {
          signals.push(signal);
          setImmediate(() => child.emit('close', null));
          return true;
        };
        setImmediate(() => child.stdout.write(`${JSON.stringify({
          type: 'assistant',
          message: { content: [
            { type: 'tool_use', id: 'one', name: 'Bash', input: { command: 'touch /tmp/one' } },
            { type: 'tool_use', id: 'two', name: 'Bash', input: { command: 'touch /tmp/two' } },
          ] },
        })}\n`));
        return child;
      },
    });
    const result = await runner.run(task('multi-side-effect'), {}, {
      ...callbacks(),
      async onToolBatch(batch) { batches.push(batch); },
      onToolStart(detail) {
        toolStarts.push(detail);
        if (detail.toolUseId === 'one') sideEffects[0] += 1;
        if (detail.toolUseId === 'two') sideEffects[1] += 1;
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.stopReason, 'multiple_tool_calls');
    assert.deepEqual(signals, ['SIGTERM']);
    assert.deepEqual(toolStarts, []);
    assert.deepEqual(sideEffects, [0, 0]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].toolCalls.length, 2);
    assert.match(db.prepare("SELECT body FROM messages WHERE role = 'system' ORDER BY sequence DESC LIMIT 1").get().body, /one tool call/i);
  } finally {
    db.close();
  }
});
