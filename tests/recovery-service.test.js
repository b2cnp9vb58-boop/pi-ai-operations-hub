import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RecoveryService } from '../src/core/recovery-service.js';
import { TaskService } from '../src/core/task-service.js';
import { openDatabase } from '../src/db/database.js';

function fixture({ maxAttempts = 3 } = {}) {
  const filename = join(tmpdir(), `pi-control-recovery-${randomUUID()}.sqlite`);
  const db = openDatabase(filename);
  let now = Date.parse('2026-08-03T00:00:00.000Z');
  const taskService = new TaskService(db, { workerId: 'worker-a', leaseMs: 1_000, clock: () => now });
  const recovery = new RecoveryService({ db, clock: () => now, maxAttempts });
  return {
    db, filename, taskService, recovery,
    advance(milliseconds) { now += milliseconds; },
    clock: () => now,
    cleanup() {
      try { db.close(); } catch (error) { if (error?.code !== 'ERR_INVALID_STATE') throw error; }
      for (const suffix of ['', '-shm', '-wal']) if (existsSync(`${filename}${suffix}`)) rmSync(`${filename}${suffix}`);
    },
  };
}

function submit(service, requestId, text) {
  return service.submit({ requestId, channel: 'telegram', text, attachments: [] });
}

test('queued work survives startup and remains claimable', () => {
  const f = fixture();
  try {
    const queued = submit(f.taskService, 'queued', 'ordinary queued task');
    const report = f.recovery.reconcileStartup();
    assert.deepEqual(report.queued, [queued.id]);
    assert.equal(f.taskService.claimNext().id, queued.id);
  } finally {
    f.cleanup();
  }
});

test('a stale named read-only task requeues with the same Claude session', () => {
  const f = fixture();
  try {
    const task = submit(f.taskService, 'safe', 'status');
    const running = f.taskService.claimNext();
    assert.equal(f.taskService.persistSession(running.id, 'worker-a', 'claude-session-1'), true);
    f.advance(1_001);

    const report = f.recovery.reconcileStartup();
    assert.deepEqual(report.autoResumed, [task.id]);
    const stored = f.taskService.get(task.id);
    assert.equal(stored.state, 'queued');
    assert.equal(stored.claudeSessionId, 'claude-session-1');

    const secondWorker = new TaskService(f.db, { workerId: 'worker-b', leaseMs: 1_000, clock: f.clock });
    const resumed = secondWorker.claimNext();
    assert.equal(resumed.id, task.id);
    assert.equal(resumed.claudeSessionId, 'claude-session-1');
  } finally {
    f.cleanup();
  }
});

test('stale high-risk and waiting-confirmation work is interrupted and old grants are invalidated', () => {
  const f = fixture();
  try {
    const high = submit(f.taskService, 'high', 'restart:nginx.service');
    f.taskService.claimNext();
    const now = new Date(f.clock()).toISOString();
    f.db.prepare(`
      INSERT INTO approvals(id, task_id, owner_id, operation_hash, state, expires_at, created_at)
      VALUES ('approval-old', ?, '123', ?, 'granted', '2099-01-01T00:00:00.000Z', ?)
    `).run(high.id, 'a'.repeat(64), now);
    f.advance(1_001);
    const report = f.recovery.reconcileStartup();

    assert.deepEqual(report.autoResumed, []);
    assert.deepEqual(report.interrupted, [high.id]);
    assert.equal(f.taskService.get(high.id).state, 'interrupted');
    assert.equal(f.db.prepare("SELECT state FROM approvals WHERE id = 'approval-old'").get().state, 'cancelled');

    const waiting = submit(f.taskService, 'waiting', 'status');
    f.db.prepare("UPDATE tasks SET state = 'waiting_confirmation' WHERE id = ?").run(waiting.id);
    f.db.prepare(`
      INSERT INTO deferred_tool_calls(approval_id, task_id, owner_id, session_id, tool_use_id,
        tool_name, tool_input_json, operation_hash, state, created_at, updated_at)
      VALUES ('deferred-old', ?, '123', 's', 'u', 'Bash', '{}', ?, 'waiting_password', ?, ?)
    `).run(waiting.id, 'b'.repeat(64), now, now);
    f.db.prepare(`
      INSERT INTO tool_batches(id, task_id, owner_id, session_id, generation, tool_count,
        service_instance_id, state, created_at)
      VALUES ('batch-old', ?, '123', 's', 1, 1, 'old-process', 'registered', ?)
    `).run(waiting.id, now);
    f.recovery.reconcileStartup();
    assert.equal(f.taskService.get(waiting.id).state, 'interrupted');
    assert.equal(f.db.prepare("SELECT state FROM deferred_tool_calls WHERE approval_id = 'deferred-old'").get().state, 'cancelled');
    assert.equal(f.db.prepare("SELECT state FROM tool_batches WHERE id = 'batch-old'").get().state, 'invalid');
  } finally {
    f.cleanup();
  }
});

test('lease heartbeat uses worker CAS and stale recovery never creates two workers', () => {
  const f = fixture();
  try {
    const task = submit(f.taskService, 'lease', 'status');
    const workerB = new TaskService(f.db, { workerId: 'worker-b', leaseMs: 1_000, clock: f.clock });
    const first = f.taskService.claimNext();
    assert.equal(first.id, task.id);
    assert.equal(workerB.claimNext(), null);
    assert.equal(workerB.heartbeat(task.id), false);
    f.advance(500);
    assert.equal(f.taskService.heartbeat(task.id), true);
    f.advance(1_001);
    assert.deepEqual(f.recovery.reconcileStartup().autoResumed, [task.id]);
    const second = workerB.claimNext();
    assert.equal(second.id, task.id);
    assert.equal(f.taskService.heartbeat(task.id), false);
    assert.equal(workerB.heartbeat(task.id), true);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state = 'running'").get().count, 1);
  } finally {
    f.cleanup();
  }
});

test('a stale worker cannot finish cancellation after another worker reclaims the task', () => {
  const f = fixture();
  try {
    const task = submit(f.taskService, 'stale-cancel', 'status');
    f.taskService.claimNext();
    f.advance(1_001);
    assert.deepEqual(f.recovery.reconcileStartup().autoResumed, [task.id]);
    const workerB = new TaskService(f.db, { workerId: 'worker-b', leaseMs: 1_000, clock: f.clock });
    assert.equal(workerB.claimNext().id, task.id);

    assert.equal(f.taskService.finishCancellation(task.id, 'worker-a'), false);
    assert.equal(workerB.get(task.id).state, 'running');
    assert.equal(workerB.get(task.id).workerId, 'worker-b');
  } finally {
    f.cleanup();
  }
});

test('the owning worker can finish cancellation and admin force cancellation is explicit', () => {
  const f = fixture();
  try {
    const owned = submit(f.taskService, 'owned-cancel', 'ordinary');
    f.taskService.claimNext();
    assert.equal(f.taskService.requestCancel(owned.id).state, 'cancelling');
    assert.equal(f.taskService.finishCancellation(owned.id, 'worker-a'), true);
    assert.equal(f.taskService.get(owned.id).state, 'interrupted');

    const forced = submit(f.taskService, 'admin-force', 'ordinary');
    f.taskService.claimNext();
    assert.equal(f.taskService.forceFinishCancellation(forced.id), true);
    assert.equal(f.taskService.get(forced.id).state, 'interrupted');
  } finally {
    f.cleanup();
  }
});

test('repeated crashes stop at the retry limit and enqueue one alert', () => {
  const f = fixture({ maxAttempts: 2 });
  try {
    const task = submit(f.taskService, 'crash-loop', 'status');
    f.taskService.claimNext();
    f.advance(1_001);
    assert.deepEqual(f.recovery.reconcileStartup().autoResumed, [task.id]);
    f.taskService.claimNext();
    f.advance(1_001);
    const stopped = f.recovery.reconcileStartup();
    assert.deepEqual(stopped.autoResumed, []);
    assert.deepEqual(stopped.interrupted, [task.id]);
    assert.equal(f.taskService.claimNext(), null);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'alert'").get().count, 1);
    f.recovery.reconcileStartup();
    assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE kind = 'alert'").get().count, 1);
  } finally {
    f.cleanup();
  }
});

test('startup performs SQLite quick_check after WAL reopen', () => {
  const f = fixture();
  const filename = f.filename;
  try {
    submit(f.taskService, 'wal', 'queued after WAL');
    f.db.close();
    const reopened = openDatabase(filename);
    const report = new RecoveryService({ db: reopened, clock: f.clock }).reconcileStartup();
    assert.equal(report.database, 'ok');
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM tasks WHERE state = 'queued'").get().count, 1);
    reopened.close();
  } finally {
    f.cleanup();
  }
});
