import { createHash, randomInt } from 'node:crypto';

const PAIRING_TTL_MS = 10 * 60 * 1000;

function timestamp(now) {
  return now.toISOString();
}

function hash(code) {
  return createHash('sha256').update(code).digest('hex');
}

function code() {
  return String(randomInt(10_000_000, 100_000_000));
}

function validCode(value) {
  return typeof value === 'string' && /^\d{8}$/.test(value);
}

function validWeixinUserId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256;
}

function transact(db, work) {
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

export function authorizeWeixinSender(db, userId) {
  if (!validWeixinUserId(userId)) return false;
  const owner = db.prepare('SELECT user_id FROM weixin_owner_binding WHERE singleton = 1').get();
  return Boolean(owner && owner.user_id === userId);
}

export function createWeixinPairingRequest(db, nowFactory = () => new Date()) {
  const now = nowFactory();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new TypeError('pairing clock must return a valid date');
  return transact(db, () => {
    if (db.prepare('SELECT 1 FROM weixin_owner_binding WHERE singleton = 1').get()) {
      throw new Error('a WeChat owner is already paired');
    }
    const value = code();
    const createdAt = timestamp(now);
    const expiresAt = timestamp(new Date(now.valueOf() + PAIRING_TTL_MS));
    db.prepare('DELETE FROM weixin_pairing_requests').run();
    db.prepare(`
      INSERT INTO weixin_pairing_requests(code_hash, expires_at, created_at) VALUES (?, ?, ?)
    `).run(hash(value), expiresAt, createdAt);
    return { code: value, expiresAt };
  });
}

export function approveWeixinPairing(db, value, userId, nowFactory = () => new Date()) {
  const now = nowFactory();
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new TypeError('pairing clock must return a valid date');
  if (!validCode(value) || !validWeixinUserId(userId)) throw new Error('invalid pairing request');
  const outcome = transact(db, () => {
    const request = db.prepare('SELECT expires_at FROM weixin_pairing_requests WHERE code_hash = ?').get(hash(value));
    db.prepare('DELETE FROM weixin_pairing_requests').run();
    if (!request) return { error: 'invalid or used pairing code' };
    if (Date.parse(request.expires_at) <= now.valueOf()) return { error: 'pairing code expired' };
    if (db.prepare('SELECT 1 FROM weixin_owner_binding WHERE singleton = 1').get()) {
      return { error: 'a WeChat owner is already paired' };
    }
    const pairedAt = timestamp(now);
    db.prepare(`
      INSERT INTO weixin_owner_binding(singleton, user_id, paired_at) VALUES (1, ?, ?)
    `).run(userId, pairedAt);
    return { userId, pairedAt };
  });
  if (outcome.error) throw new Error(outcome.error);
  return outcome;
}
