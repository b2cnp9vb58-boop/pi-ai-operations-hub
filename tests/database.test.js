import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import {
  appendMessage,
  appendOutbox,
  claimOutbox,
  createTask,
  markOutboxSent,
  recordTelegramUpdate,
  transitionTask,
} from '../src/db/repositories.js';

function temporaryDatabase() {
  const filename = join(tmpdir(), `pi-control-${randomUUID()}.sqlite`);
  return {
    filename,
    open: () => openDatabase(filename),
    cleanup: () => {
      for (const suffix of ['', '-shm', '-wal']) {
        const path = `${filename}${suffix}`;
        if (existsSync(path)) rmSync(path);
      }
    },
  };
}

test('messages receive a stable global sequence', () => {
  const db = openDatabase(':memory:');
  try {
    const first = appendMessage(db, { channel: 'telegram', role: 'user', body: '检查网站' });
    const second = appendMessage(db, { channel: 'web', role: 'assistant', body: '开始检查' });

    assert.deepEqual([first.sequence, second.sequence], [1, 2]);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 2);
  } finally {
    db.close();
  }
});

test('telegram update ids are accepted once across database reopen', () => {
  const fixture = temporaryDatabase();
  try {
    const first = fixture.open();
    assert.equal(recordTelegramUpdate(first, 101), true);
    first.close();

    const reopened = fixture.open();
    assert.equal(recordTelegramUpdate(reopened, 101), false);
    reopened.close();
  } finally {
    fixture.cleanup();
  }
});

test('task transitions reject stale source states without adding an event', () => {
  const db = openDatabase(':memory:');
  try {
    const task = createTask(db, { source: 'telegram', requestMessageId: 'm1' });

    assert.throws(() => transitionTask(db, task.id, 'running', 'completed', {}), /state conflict/);
    assert.equal(db.prepare('SELECT state FROM tasks WHERE id = ?').get(task.id).state, 'queued');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM task_events WHERE task_id = ?').get(task.id).count, 1);
  } finally {
    db.close();
  }
});

test('task transition atomically persists its patch and append-only event', () => {
  const db = openDatabase(':memory:');
  try {
    const task = createTask(db, { source: 'web', requestMessageId: 'm2' });
    const transitioned = transitionTask(db, task.id, 'queued', 'running', { claudeSessionId: 'session-1' });

    assert.equal(transitioned.state, 'running');
    assert.equal(transitioned.claudeSessionId, 'session-1');
    const events = db.prepare('SELECT kind, payload_json FROM task_events WHERE task_id = ? ORDER BY id').all(task.id);
    assert.deepEqual(events.map((event) => event.kind), ['created', 'transitioned']);
    assert.deepEqual(JSON.parse(events[1].payload_json), {
      from: 'queued',
      patch: { claudeSessionId: 'session-1' },
      to: 'running',
    });
  } finally {
    db.close();
  }
});

test('outbox claims each due event once and records delivery durably', () => {
  const fixture = temporaryDatabase();
  try {
    const db = fixture.open();
    const first = appendOutbox(db, { kind: 'telegram.send', payload: { chatId: '1', text: 'one' } });
    const second = appendOutbox(db, { kind: 'telegram.send', payload: { chatId: '1', text: 'two' } });

    const claimed = claimOutbox(db, 10);
    assert.deepEqual(claimed.map((event) => event.id), [first.id, second.id]);
    assert.equal(claimOutbox(db, 10).length, 0);
    markOutboxSent(db, first.id);
    db.close();

    const reopened = fixture.open();
    const delivered = reopened.prepare('SELECT state, attempts, sent_at FROM outbox WHERE id = ?').get(first.id);
    assert.equal(delivered.state, 'sent');
    assert.equal(delivered.attempts, 1);
    assert.match(delivered.sent_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(reopened.prepare('SELECT state FROM outbox WHERE id = ?').get(second.id).state, 'sending');
    reopened.close();
  } finally {
    fixture.cleanup();
  }
});

test('schema remains internally consistent', () => {
  const db = openDatabase(':memory:');
  try {
    appendMessage(db, { channel: 'system', role: 'system', body: 'started' });
    const task = createTask(db, { source: 'telegram', requestMessageId: 'm3' });
    transitionTask(db, task.id, 'queued', 'completed', { resultSummary: 'ok' });

    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
