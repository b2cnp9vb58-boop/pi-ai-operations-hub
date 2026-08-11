import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { ClaudeRunner } from '../src/core/claude-runner.js';
import { ConversationService } from '../src/core/conversation-service.js';
import { TaskService } from '../src/core/task-service.js';
import { ProgressPublisher } from '../src/telegram/progress.js';

test('progress uses one throttled card and stops after the final state', async () => {
  let now = 0;
  const sent = [];
  const edited = [];
  const client = {
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 91 }; },
    async editMessageText(chatId, messageId, text) { edited.push({ chatId, messageId, text }); return true; },
  };
  const publisher = new ProgressPublisher({ client, chatId: 456, intervalMs: 5_000, clock: () => now });
  await publisher.publish({ taskId: 'task', kind: 'accepted', text: 'accepted' });
  now = 1_000;
  await publisher.publish({ taskId: 'task', kind: 'tool_start', text: 'working' });
  now = 5_000;
  await publisher.publish({ taskId: 'task', kind: 'tool_start', text: 'checking nginx' });
  now = 5_100;
  await publisher.publish({ taskId: 'task', kind: 'completed', text: 'done with evidence' });
  await publisher.publish({ taskId: 'task', kind: 'tool_start', text: 'must be ignored' });
  assert.equal(sent.length, 1);
  assert.deepEqual(edited.map((item) => item.text), ['checking nginx', 'done with evidence']);
  assert.ok(edited.every((item) => item.messageId === 91));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  return child;
}

async function waitFor(condition, description, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('cancel waits for the active tool boundary, is idempotent and persists cancellation', async () => {
  const db = openDatabase(':memory:');
  const child = fakeChild();
  try {
    const tasks = new TaskService(db);
    const task = tasks.submit({ requestId: 'cancel', channel: 'telegram', text: 'work', attachments: [] });
    const claimed = tasks.claimNext();
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: '/fake', claudeCwd: process.cwd() },
      spawn: () => child,
      cancelGraceMs: 20,
      taskService: tasks,
    });
    const running = runner.run({ ...claimed, text: 'work', channel: 'telegram' }, {}, {});
    runner.noteToolStart(task.id, 'tool-1');
    assert.equal(runner.cancelSafely(task.id), true);
    assert.equal(runner.cancelSafely(task.id), true);
    assert.deepEqual(child.signals, []);
    runner.noteToolEnd(task.id, 'tool-1');
    assert.deepEqual(child.signals, ['SIGINT']);
    const cancelling = tasks.requestCancel(task.id);
    assert.equal(cancelling.state, 'cancelling');
    assert.equal(tasks.requestCancel(task.id).state, 'cancelling');
    child.emit('close', 130);
    const result = await running;
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(db.prepare('SELECT state FROM tasks WHERE id = ?').get(task.id).state, 'interrupted');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_events WHERE task_id = ? AND payload_json LIKE '%\"to\":\"cancelling\"%'").get(task.id).count, 1);
  } finally { db.close(); }
});

test('idle cancellation sends SIGINT immediately and escalates once', async () => {
  const db = openDatabase(':memory:');
  const child = fakeChild();
  try {
    const runner = new ClaudeRunner({ conversationService: new ConversationService(db),
      config: { claudeBin: '/fake', claudeCwd: process.cwd() }, spawn: () => child, cancelGraceMs: 10 });
    const running = runner.run({ id: 'idle', text: 'work', channel: 'telegram' }, {}, {});
    assert.equal(runner.cancelSafely('idle'), true);
    await waitFor(() => child.signals.length === 2, 'cancel escalation');
    assert.deepEqual(child.signals, ['SIGINT', 'SIGTERM']);
    child.emit('close', 143);
    assert.equal((await running).stopReason, 'cancelled');
  } finally { db.close(); }
});

test('Claude runner binds cancellation completion to the active worker id', async () => {
  const db = openDatabase(':memory:');
  const child = fakeChild();
  const completions = [];
  try {
    const runner = new ClaudeRunner({
      conversationService: new ConversationService(db),
      config: { claudeBin: '/fake', claudeCwd: process.cwd() },
      spawn: () => child,
      taskService: { finishCancellation: (taskId, workerId) => { completions.push({ taskId, workerId }); return true; } },
    });
    const running = runner.run({ id: 'leased-task', workerId: 'worker-a', text: 'work', channel: 'telegram' }, {}, {});
    runner.cancelSafely('leased-task');
    child.emit('close', 130);
    assert.equal((await running).stopReason, 'cancelled');
    assert.deepEqual(completions, [{ taskId: 'leased-task', workerId: 'worker-a' }]);
  } finally {
    db.close();
  }
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('concurrent progress publishes one card, preserves queued final ordering and unlocks after failure', async () => {
  let now = 0;
  const firstSend = deferred();
  const calls = [];
  let sendAttempt = 0;
  const client = {
    async sendMessage(_chatId, text) {
      calls.push(`send:${text}`);
      sendAttempt += 1;
      if (sendAttempt === 1) return firstSend.promise;
      return { message_id: 77 };
    },
    async editMessageText(_chatId, _messageId, text) { calls.push(`edit:${text}`); return true; },
  };
  const publisher = new ProgressPublisher({ client, chatId: 456, clock: () => now, intervalMs: 1 });
  const accepted = publisher.publish({ taskId: 'one', kind: 'accepted', text: 'accepted' });
  const concurrent = publisher.publish({ taskId: 'one', kind: 'tool_start', text: 'ordinary' });
  firstSend.resolve({ message_id: 77 });
  await Promise.all([accepted, concurrent]);
  now = 2;
  const final = publisher.publish({ taskId: 'one', kind: 'completed', text: 'final' });
  const late = publisher.publish({ taskId: 'one', kind: 'tool_start', text: 'late' });
  await Promise.all([final, late]);
  assert.equal(calls.filter((value) => value.startsWith('send:')).length, 1);
  assert.equal(calls.at(-1), 'edit:final');

  let retryAttempt = 0;
  const failing = new ProgressPublisher({ client: {
    sendMessage: async () => {
      retryAttempt += 1;
      if (retryAttempt === 1) throw new Error('network');
      return { message_id: 88 };
    }, editMessageText: client.editMessageText,
  }, chatId: 456 });
  await assert.rejects(failing.publish({ taskId: 'retry', kind: 'accepted', text: 'first' }), /network/);
  assert.equal((await failing.publish({ taskId: 'retry', kind: 'accepted', text: 'retry' })).published, true);
});

test('failed first final send rolls back suppression so ordinary and final can retry', async () => {
  let attempts = 0;
  const calls = [];
  const publisher = new ProgressPublisher({ client: {
    async sendMessage(_chat, text) {
      calls.push(text);
      attempts += 1;
      if (attempts === 1) throw new Error('send failed');
      return { message_id: 12 };
    },
    async editMessageText(_chat, _id, text) { calls.push(text); return true; },
  }, chatId: 456, intervalMs: 1, clock: () => 10 });
  await assert.rejects(publisher.publish({ taskId: 'send-final', kind: 'completed', text: 'final-1' }), /send failed/);
  assert.equal((await publisher.publish({ taskId: 'send-final', kind: 'tool_start', text: 'ordinary-retry' })).published, true);
  assert.equal((await publisher.publish({ taskId: 'send-final', kind: 'completed', text: 'final-2' })).published, true);
  assert.deepEqual(calls, ['final-1', 'ordinary-retry', 'final-2']);
});

test('failed final edit rolls back suppression without overriding a later successful final', async () => {
  let editAttempt = 0;
  const edits = [];
  let now = 0;
  const publisher = new ProgressPublisher({ client: {
    async sendMessage() { return { message_id: 13 }; },
    async editMessageText(_chat, _id, text) {
      editAttempt += 1;
      edits.push(text);
      if (editAttempt === 1) throw new Error('edit failed');
      return true;
    },
  }, chatId: 456, intervalMs: 1, clock: () => now });
  await publisher.publish({ taskId: 'edit-final', kind: 'accepted', text: 'accepted' });
  await assert.rejects(publisher.publish({ taskId: 'edit-final', kind: 'completed', text: 'final-failed' }), /edit failed/);
  now = 2;
  assert.equal((await publisher.publish({ taskId: 'edit-final', kind: 'tool_start', text: 'ordinary-after-failure' })).published, true);
  assert.equal((await publisher.publish({ taskId: 'edit-final', kind: 'completed', text: 'final-success' })).published, true);
  assert.equal((await publisher.publish({ taskId: 'edit-final', kind: 'tool_start', text: 'suppressed' })).published, false);
  assert.deepEqual(edits, ['final-failed', 'ordinary-after-failure', 'final-success']);
});
