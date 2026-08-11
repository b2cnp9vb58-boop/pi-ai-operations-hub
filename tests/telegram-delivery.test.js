import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskService } from '../src/core/task-service.js';
import { openDatabase } from '../src/db/database.js';
import { appendOutbox } from '../src/db/repositories.js';
import { TelegramDeliveryWorker } from '../src/telegram/delivery.js';

function outboxRows(db) {
  return db.prepare('SELECT kind, payload_json, state, attempts FROM outbox ORDER BY id').all()
    .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
}

test('Telegram tasks durably enqueue one receipt and one terminal result while web tasks stay private', () => {
  const db = openDatabase(':memory:');
  try {
    const tasks = new TaskService(db, { workerId: 'worker-1' });
    const telegramTask = tasks.submit({
      requestId: 'telegram:100', channel: 'telegram', text: 'status', attachments: [],
    });
    tasks.submit({ requestId: 'web:100', channel: 'web', text: 'private web task', attachments: [] });

    const claimed = tasks.claimNext();
    assert.equal(claimed.id, telegramTask.id);
    assert.equal(tasks.finish(claimed.id, { status: 'completed', summary: 'all systems healthy' }), true);

    const rows = outboxRows(db);
    assert.deepEqual(rows.map(({ kind }) => kind), ['telegram.task.accepted', 'telegram.task.result']);
    assert.deepEqual(rows[0].payload, { taskId: telegramTask.id });
    assert.deepEqual(rows[1].payload, {
      taskId: telegramTask.id, status: 'completed', summary: 'all systems healthy',
    });
  } finally {
    db.close();
  }
});

test('Telegram delivery sends only Telegram outbox events to the bound owner and marks them sent', async () => {
  const db = openDatabase(':memory:');
  const sent = [];
  try {
    appendOutbox(db, { kind: 'alert', payload: { probe: 'website' } });
    appendOutbox(db, { kind: 'telegram.task.accepted', payload: { taskId: 'task-1' } });
    appendOutbox(db, {
      kind: 'telegram.task.result', payload: { taskId: 'task-1', status: 'completed', summary: 'finished result' },
    });
    const worker = new TelegramDeliveryWorker({
      db,
      client: { async sendMessage(chatId, text, options) { sent.push({ chatId, text, options }); return { message_id: sent.length }; } },
      getOwner: () => ({ userId: '12937185', chatId: '456' }),
    });

    assert.equal(await worker.flushOnce(), 2);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent.map(({ chatId }) => chatId), [456, 456]);
    assert.equal(sent[0].text, '任务已收到，正在处理…');
    assert.match(sent[1].text, /finished result/);
    assert.deepEqual(db.prepare('SELECT kind, state FROM outbox ORDER BY id').all().map((row) => ({ ...row })), [
      { kind: 'alert', state: 'pending' },
      { kind: 'telegram.task.accepted', state: 'sent' },
      { kind: 'telegram.task.result', state: 'sent' },
    ]);
  } finally {
    db.close();
  }
});

test('failed Telegram delivery returns the event to the durable retry queue', async () => {
  const db = openDatabase(':memory:');
  const now = Date.parse('2030-01-01T00:00:00.000Z');
  try {
    appendOutbox(db, { kind: 'telegram.task.result', payload: { taskId: 'task-2', status: 'failed', summary: 'worker failed' } });
    const worker = new TelegramDeliveryWorker({
      db,
      client: { async sendMessage() { throw new Error('network unavailable'); } },
      getOwner: () => ({ userId: '12937185', chatId: '456' }),
      clock: () => now,
      retryDelayMs: 30_000,
    });

    assert.equal(await worker.flushOnce(), 0);
    const row = { ...db.prepare('SELECT state, attempts, next_attempt_at FROM outbox').get() };
    assert.deepEqual(row, {
      state: 'pending', attempts: 1, next_attempt_at: '2030-01-01T00:00:30.000Z',
    });
  } finally {
    db.close();
  }
});
