import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskService } from '../src/core/task-service.js';
import { openDatabase } from '../src/db/database.js';

function temporaryDatabase() {
  const filename = join(tmpdir(), `pi-control-task-${randomUUID()}.sqlite`);
  return {
    filename,
    open: () => openDatabase(filename),
    cleanup() {
      for (const suffix of ['', '-shm', '-wal']) {
        const path = `${filename}${suffix}`;
        if (existsSync(path)) rmSync(path);
      }
    },
  };
}

test('duplicate request ids return the original durable task after restart', () => {
  const fixture = temporaryDatabase();
  try {
    const firstDb = fixture.open();
    let first;
    try {
      first = new TaskService(firstDb).submit({
        requestId: 'telegram-update-101',
        channel: 'telegram',
        text: '检查网站',
        attachments: [],
      });
    } finally {
      firstDb.close();
    }

    const reopened = fixture.open();
    try {
      const second = new TaskService(reopened).submit({
        requestId: 'telegram-update-101',
        channel: 'telegram',
        text: '检查网站',
        attachments: [],
      });

      assert.equal(second.id, first.id);
      assert.equal(second.eventCursor, first.eventCursor);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM task_events').get().count, 1);
      const linkage = reopened.prepare(`
        SELECT tasks.request_message_id AS requestMessageId, messages.id AS messageId
        FROM tasks JOIN messages ON messages.task_id = tasks.id
      `).get();
      assert.equal(linkage.requestMessageId, linkage.messageId);
    } finally {
      reopened.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test('a request id reused with different text conflicts after database reopen', () => {
  const fixture = temporaryDatabase();
  const firstDb = fixture.open();
  let first;
  try {
    first = new TaskService(firstDb).submit({
      requestId: 'durable-conflict', channel: 'telegram', text: 'original', attachments: [],
    });
  } finally {
    firstDb.close();
  }

  const reopened = fixture.open();
  try {
    assert.throws(
      () => new TaskService(reopened).submit({
        requestId: 'durable-conflict', channel: 'telegram', text: 'changed', attachments: [],
      }),
      (error) => error?.code === 'request_conflict',
    );
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    assert.equal(reopened.prepare('SELECT body FROM messages WHERE task_id = ?').get(first.id).body, 'original');
  } finally {
    reopened.close();
    fixture.cleanup();
  }
});

test('canonical attachment objects ignore key order while attachment array order remains significant', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new TaskService(db);
    const first = service.submit({
      requestId: 'attachment-order',
      channel: 'web',
      text: 'inspect',
      attachments: [{ name: 'a.txt', metadata: { size: 1, type: 'text/plain' } }, { name: 'b.txt' }],
    });
    const same = service.submit({
      requestId: 'attachment-order',
      channel: 'web',
      text: 'inspect',
      attachments: [{ metadata: { type: 'text/plain', size: 1 }, name: 'a.txt' }, { name: 'b.txt' }],
    });
    assert.equal(same.id, first.id);
    assert.throws(
      () => service.submit({
        requestId: 'attachment-order',
        channel: 'web',
        text: 'inspect',
        attachments: [{ name: 'b.txt' }, { name: 'a.txt', metadata: { size: 1, type: 'text/plain' } }],
      }),
      (error) => error?.code === 'request_conflict',
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
  } finally {
    db.close();
  }
});

test('request id de-duplication is namespaced by channel', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new TaskService(db);
    const telegram = service.submit({ requestId: 'shared', channel: 'telegram', text: 'one', attachments: [] });
    const web = service.submit({ requestId: 'shared', channel: 'web', text: 'two', attachments: [] });

    assert.notEqual(web.id, telegram.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 2);
  } finally {
    db.close();
  }
});

test('claimNext atomically starts the oldest queued task and enforces one global worker', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new TaskService(db);
    const first = service.submit({ requestId: '1', channel: 'telegram', text: 'one', attachments: [] });
    service.submit({ requestId: '2', channel: 'web', text: 'two', attachments: [] });

    const claimed = service.claimNext();
    assert.equal(claimed.id, first.id);
    assert.equal(claimed.state, 'running');
    assert.equal(service.claimNext(), null);
    assert.deepEqual(
      db.prepare('SELECT state FROM tasks ORDER BY rowid').all().map(({ state }) => state),
      ['running', 'queued'],
    );
    assert.deepEqual(
      db.prepare('SELECT kind FROM task_events WHERE task_id = ? ORDER BY id').all(first.id).map(({ kind }) => kind),
      ['created', 'transitioned'],
    );
  } finally {
    db.close();
  }
});

test('claimNext enforces the worker lock across connections to the same database', () => {
  const fixture = temporaryDatabase();
  const firstDb = fixture.open();
  const secondDb = fixture.open();
  try {
    const firstService = new TaskService(firstDb);
    const secondService = new TaskService(secondDb);
    firstService.submit({ requestId: 'connection-1', channel: 'telegram', text: 'one', attachments: [] });
    firstService.submit({ requestId: 'connection-2', channel: 'web', text: 'two', attachments: [] });

    assert.ok(firstService.claimNext());
    assert.equal(secondService.claimNext(), null);
    assert.equal(secondDb.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state = 'running'").get().count, 1);
    assert.equal(secondDb.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state = 'queued'").get().count, 1);
  } finally {
    secondDb.close();
    firstDb.close();
    fixture.cleanup();
  }
});

test('claimNext remains blocked by every nonterminal worker state', () => {
  for (const activeState of ['running', 'waiting_confirmation', 'cancelling']) {
    const db = openDatabase(':memory:');
    try {
      const service = new TaskService(db);
      const active = service.submit({ requestId: `active-${activeState}`, channel: 'telegram', text: 'one', attachments: [] });
      service.submit({ requestId: `queued-${activeState}`, channel: 'web', text: 'two', attachments: [] });
      db.prepare('UPDATE tasks SET state = ? WHERE id = ?').run(activeState, active.id);

      assert.equal(service.claimNext(), null, activeState);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state = 'queued'").get().count, 1);
    } finally {
      db.close();
    }
  }
});

test('requestCancel stops queued work and marks active work for safe cancellation', () => {
  const db = openDatabase(':memory:');
  try {
    const service = new TaskService(db);
    const queued = service.submit({ requestId: 'queued', channel: 'telegram', text: 'one', attachments: [] });
    assert.equal(service.requestCancel(queued.id).state, 'interrupted');

    const active = service.submit({ requestId: 'active', channel: 'web', text: 'two', attachments: [] });
    assert.equal(service.claimNext().id, active.id);
    const cancelling = service.requestCancel(active.id);
    assert.equal(cancelling.state, 'cancelling');
    assert.equal(cancelling.cancelRequested, true);
    assert.equal(service.claimNext(), null);
    assert.equal(service.requestCancel('missing-task'), null);
  } finally {
    db.close();
  }
});
