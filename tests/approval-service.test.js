import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { MIGRATION_1, MIGRATION_2 } from '../src/db/migrations.js';
import { hashConfirmationPassword } from '../src/security/password.js';
import { ApprovalService } from '../src/security/approval-service.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const OWNER_A = '10001';
const OWNER_B = '20002';

function request(service, taskId, operationHash = HASH_A, ownerId = OWNER_A) {
  return service.request({ taskId, ownerId, operationHash });
}

function fixture() {
  let now = Date.parse('2026-08-02T00:00:00.000Z');
  const filename = join(tmpdir(), `pi-control-approval-${randomUUID()}.sqlite`);
  const db = openDatabase(filename);
  return {
    db,
    clock: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    cleanup: () => {
      db.close();
      for (const suffix of ['', '-shm', '-wal']) {
        const path = `${filename}${suffix}`;
        if (existsSync(path)) rmSync(path);
      }
    },
  };
}

test('one grant cannot authorize a changed or repeated operation', async () => {
  const f = fixture();
  try {
    const service = new ApprovalService({
      db: f.db,
      passwordRecord: await hashConfirmationPassword('correct'),
      clock: f.clock,
    });
    const pending = request(service, 't');
    assert.equal(await service.grantWithPassword(pending.id, 'correct'), true);
    assert.equal(service.consume(pending.id, { taskId: 't', ownerId: OWNER_A, operationHash: HASH_B }), false);
    assert.equal(service.consume(pending.id, { taskId: 't', ownerId: OWNER_A, operationHash: HASH_A }), true);
    assert.equal(service.consume(pending.id, { taskId: 't', ownerId: OWNER_A, operationHash: HASH_A }), false);
  } finally {
    f.cleanup();
  }
});

test('pending and granted approvals expire after 120 seconds', async () => {
  const f = fixture();
  try {
    const service = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct'), clock: f.clock });
    const pending = request(service, 't1');
    const granted = request(service, 't2', HASH_B);
    assert.equal(await service.grantWithPassword(granted.id, 'correct'), true);
    f.advance(120_000);
    assert.equal(service.consume(granted.id, { taskId: 't2', ownerId: OWNER_A, operationHash: HASH_B }), false);
    assert.equal(service.expire(), 2);
    assert.deepEqual(
      f.db.prepare('SELECT state FROM approvals WHERE id IN (?, ?) ORDER BY task_id').all(pending.id, granted.id).map((row) => row.state),
      ['expired', 'expired'],
    );
  } finally {
    f.cleanup();
  }
});

test('five wrong passwords lock only high-risk grants for five minutes', async () => {
  const f = fixture();
  try {
    const service = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct'), clock: f.clock });
    const approvals = Array.from({ length: 7 }, (_, index) => request(service, `t${index}`));
    for (let index = 0; index < 5; index += 1) {
      assert.equal(await service.grantWithPassword(approvals[index].id, 'wrong'), false);
    }
    await assert.rejects(service.grantWithPassword(approvals[5].id, 'correct'), /locked/i);
    f.advance(300_000);
    const afterLockout = request(service, 'after-lockout');
    assert.equal(await service.grantWithPassword(afterLockout.id, 'correct'), true);
  } finally {
    f.cleanup();
  }
});

test('password plaintext never appears in database or audit events', async () => {
  const f = fixture();
  const events = [];
  const password = 'unique-plaintext-secret';
  try {
    const service = new ApprovalService({
      db: f.db,
      passwordRecord: await hashConfirmationPassword(password),
      clock: f.clock,
      audit: (event) => events.push(event),
    });
    const pending = request(service, 't');
    assert.equal(await service.grantWithPassword(pending.id, password), true);
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM approvals').all()).includes(password), false);
    assert.equal(JSON.stringify(events).includes(password), false);
  } finally {
    f.cleanup();
  }
});

test('a granted approval from an earlier service instance cannot be consumed after restart', async () => {
  const f = fixture();
  try {
    const passwordRecord = await hashConfirmationPassword('correct');
    const first = new ApprovalService({ db: f.db, passwordRecord, clock: f.clock });
    const pending = request(first, 't');
    assert.equal(await first.grantWithPassword(pending.id, 'correct'), true);

    const restarted = new ApprovalService({ db: f.db, passwordRecord, clock: f.clock });
    assert.equal(restarted.consume(pending.id, { taskId: 't', ownerId: OWNER_A, operationHash: HASH_A }), false);
  } finally {
    f.cleanup();
  }
});

test('consumption is atomically bound to approval id, task, owner and operation hash', async () => {
  const f = fixture();
  try {
    const service = new ApprovalService({ db: f.db, passwordRecord: await hashConfirmationPassword('correct'), clock: f.clock });
    const pending = request(service, 'task-a');
    assert.equal(await service.grantWithPassword(pending.id, 'correct'), true);
    assert.equal(service.consume(pending.id, { taskId: 'task-b', ownerId: OWNER_A, operationHash: HASH_A }), false);
    assert.equal(service.consume(pending.id, { taskId: 'task-a', ownerId: OWNER_B, operationHash: HASH_A }), false);
    const attempts = await Promise.all(Array.from({ length: 8 }, async () => service.consume(
      pending.id,
      { taskId: 'task-a', ownerId: OWNER_A, operationHash: HASH_A },
    )));
    assert.equal(attempts.filter(Boolean).length, 1);
  } finally {
    f.cleanup();
  }
});

test('five-minute password lockout survives a service restart', async () => {
  const f = fixture();
  try {
    const passwordRecord = await hashConfirmationPassword('correct');
    const first = new ApprovalService({ db: f.db, passwordRecord, clock: f.clock });
    const approvals = Array.from({ length: 5 }, (_, index) => request(first, `before-${index}`));
    for (const approval of approvals) assert.equal(await first.grantWithPassword(approval.id, 'wrong'), false);

    const restarted = new ApprovalService({ db: f.db, passwordRecord, clock: f.clock });
    await assert.rejects(restarted.grantWithPassword(approvals[0].id, 'correct'), /locked/i);
    f.advance(300_000);
    const afterLockout = request(restarted, 'after-restart-lockout');
    assert.equal(await restarted.grantWithPassword(afterLockout.id, 'correct'), true);
  } finally {
    f.cleanup();
  }
});

test('a version-two database migrates fail-closed with durable lockout state', () => {
  const filename = join(tmpdir(), `pi-control-approval-v2-${randomUUID()}.sqlite`);
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(MIGRATION_1);
    legacy.exec(MIGRATION_2);
    legacy.prepare(`
      INSERT INTO approvals(id, task_id, operation_hash, state, expires_at, created_at)
      VALUES ('legacy', 'task', ?, 'granted', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(HASH_A);
    legacy.close();

    const migrated = openDatabase(filename);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(migrated.prepare("SELECT state FROM approvals WHERE id = 'legacy'").get().state, 'cancelled');
    assert.equal(migrated.prepare('SELECT failed_attempts, locked_until FROM approval_security WHERE singleton = 1').get().failed_attempts, 0);
    assert.ok(migrated.prepare("PRAGMA table_info('approvals')").all().some((column) => column.name === 'owner_id'));
    migrated.close();
  } finally {
    for (const suffix of ['', '-shm', '-wal']) {
      const path = `${filename}${suffix}`;
      if (existsSync(path)) rmSync(path);
    }
  }
});
