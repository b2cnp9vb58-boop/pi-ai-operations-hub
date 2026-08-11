import { randomUUID } from 'node:crypto';
import { verifyConfirmationPassword } from './password.js';

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function nowMilliseconds(clock) {
  const value = typeof clock === 'function' ? clock() : Date.now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError('clock must return a valid time');
  return milliseconds;
}

function validateRequest({ taskId, ownerId, operationHash } = {}) {
  if (typeof taskId !== 'string' || taskId.length === 0) throw new TypeError('taskId is required');
  if (typeof ownerId !== 'string' || !/^[1-9]\d*$/.test(ownerId)) throw new TypeError('ownerId is required');
  if (typeof operationHash !== 'string' || !HASH_PATTERN.test(operationHash)) {
    throw new TypeError('operationHash must be a lowercase SHA-256 hash');
  }
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export class ApprovalService {
  constructor({
    db,
    passwordRecord,
    clock = Date.now,
    ttlMs = 120_000,
    maxFailures = 5,
    lockoutMs = 300_000,
    audit = () => {},
    verifyPassword = verifyConfirmationPassword,
  }) {
    if (!db?.prepare) throw new TypeError('db is required');
    if (typeof passwordRecord !== 'string') throw new TypeError('passwordRecord is required');
    this.db = db;
    this.passwordRecord = passwordRecord;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMs;
    this.audit = audit;
    this.verifyPassword = verifyPassword;
    this.activeGrants = new Set();
  }

  #now() {
    return nowMilliseconds(this.clock);
  }

  #emit(kind, fields = {}) {
    this.audit(Object.freeze({ kind, at: new Date(this.#now()).toISOString(), ...fields }));
  }

  request(request) {
    validateRequest(request);
    const id = randomUUID();
    const createdAt = this.#now();
    const expiresAt = createdAt + this.ttlMs;
    this.db.prepare(`
      INSERT INTO approvals(id, task_id, owner_id, operation_hash, state, expires_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, request.taskId, request.ownerId, request.operationHash, new Date(expiresAt).toISOString(), new Date(createdAt).toISOString());
    this.#emit('approval.requested', { approvalId: id, taskId: request.taskId, ownerId: request.ownerId });
    return { id, taskId: request.taskId, ownerId: request.ownerId, operationHash: request.operationHash, expiresAt: new Date(expiresAt).toISOString() };
  }

  async grantWithPassword(id, password) {
    const now = this.#now();
    const security = this.db.prepare('SELECT failed_attempts, locked_until FROM approval_security WHERE singleton = 1').get();
    if (security?.locked_until && Date.parse(security.locked_until) > now) {
      this.#emit('approval.locked', { approvalId: id });
      throw new Error('high-risk approval is temporarily locked');
    }
    const row = this.db.prepare('SELECT task_id, state, expires_at FROM approvals WHERE id = ?').get(id);
    if (!row || row.state !== 'pending' || Date.parse(row.expires_at) <= now) {
      if (row?.state === 'pending') this.expire();
      this.#emit('approval.rejected', { approvalId: id, reason: 'not-pending' });
      return false;
    }

    const valid = await this.verifyPassword(password, this.passwordRecord);
    if (!valid) {
      const failure = transaction(this.db, () => {
        const currentApproval = this.db.prepare('SELECT state FROM approvals WHERE id = ?').get(id);
        if (currentApproval?.state !== 'pending') return { counted: false, locked: false };
        const current = this.db.prepare('SELECT failed_attempts, locked_until FROM approval_security WHERE singleton = 1').get();
        if (current.locked_until && Date.parse(current.locked_until) > now) return { counted: false, locked: true };
        const attempts = current.failed_attempts + 1;
        const lock = attempts >= this.maxFailures;
        this.db.prepare(`
          UPDATE approval_security SET failed_attempts = ?, locked_until = ? WHERE singleton = 1
        `).run(lock ? 0 : attempts, lock ? new Date(now + this.lockoutMs).toISOString() : null);
        return { counted: true, locked: lock };
      });
      if (failure.locked && !failure.counted) throw new Error('high-risk approval is temporarily locked');
      this.#emit('approval.password-failed', { approvalId: id, taskId: row.task_id });
      return false;
    }

    const updated = transaction(this.db, () => {
      const current = this.db.prepare('SELECT locked_until FROM approval_security WHERE singleton = 1').get();
      if (current.locked_until && Date.parse(current.locked_until) > now) {
        throw new Error('high-risk approval is temporarily locked');
      }
      const result = this.db.prepare(`
        UPDATE approvals SET state = 'granted'
        WHERE id = ? AND state = 'pending' AND expires_at > ?
      `).run(id, new Date(now).toISOString());
      if (result.changes === 1) {
        this.db.prepare('UPDATE approval_security SET failed_attempts = 0, locked_until = NULL WHERE singleton = 1').run();
      }
      return result;
    });
    if (updated.changes !== 1) return false;
    this.activeGrants.add(id);
    this.#emit('approval.granted', { approvalId: id, taskId: row.task_id });
    return true;
  }

  consume(id, binding) {
    try {
      validateRequest(binding);
    } catch {
      return false;
    }
    if (!this.activeGrants.has(id)) return false;
    const now = this.#now();
    const consumedAt = new Date(now).toISOString();
    const updated = this.db.prepare(`
      UPDATE approvals SET state = 'consumed', consumed_at = ?
      WHERE id = ? AND task_id = ? AND owner_id = ? AND operation_hash = ?
        AND state = 'granted' AND expires_at > ?
    `).run(consumedAt, id, binding.taskId, binding.ownerId, binding.operationHash, consumedAt);
    if (updated.changes !== 1) {
      const row = this.db.prepare('SELECT state, expires_at FROM approvals WHERE id = ?').get(id);
      if (!row || row.state !== 'granted' || Date.parse(row.expires_at) <= now) this.activeGrants.delete(id);
      return false;
    }
    this.activeGrants.delete(id);
    this.#emit('approval.consumed', { approvalId: id });
    return true;
  }

  expire() {
    const now = new Date(this.#now()).toISOString();
    const ids = this.db.prepare(`
      SELECT id FROM approvals WHERE state IN ('pending', 'granted') AND expires_at <= ?
    `).all(now).map((row) => row.id);
    if (ids.length === 0) return 0;
    const updated = this.db.prepare(`
      UPDATE approvals SET state = 'expired'
      WHERE state IN ('pending', 'granted') AND expires_at <= ?
    `).run(now);
    for (const id of ids) this.activeGrants.delete(id);
    this.#emit('approval.expired', { count: Number(updated.changes) });
    return Number(updated.changes);
  }
}
