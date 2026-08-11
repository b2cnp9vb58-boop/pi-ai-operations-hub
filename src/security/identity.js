import { createHash, randomInt } from 'node:crypto';

const PAIRING_TTL_MS = 10 * 60 * 1000;

function nowFrom(clock) {
  const value = typeof clock === 'function'
    ? clock()
    : clock && typeof clock.now === 'function'
      ? clock.now()
      : Date.now();
  const now = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid date');
  return now;
}

function numericTelegramId(value, label) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${label} must be a positive numeric Telegram id`);
    }
    return String(value);
  }
  if (isCanonicalTelegramId(value)) return value;
  throw new TypeError(`${label} must be a positive numeric Telegram id`);
}

function isCanonicalTelegramId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value;
}

function canonicalIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function pairingCodeHash(code) {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function updateIdentity(update) {
  if (update?.message) {
    return { sender: update.message.from, message: update.message };
  }
  if (update?.callback_query?.message) {
    return { sender: update.callback_query.from, message: update.callback_query.message };
  }
  return { sender: undefined, message: undefined };
}

function denied(reason, message) {
  return { ok: false, reason, message };
}

export function authorizeTelegramUpdate(update, owner) {
  const { sender, message } = updateIdentity(update);
  if (!owner) return denied('owner-not-paired', message);
  if (!message) return denied('unsupported-update', message);
  if (!sender || !Number.isSafeInteger(sender.id) || sender.id <= 0) {
    return denied('missing-or-invalid-sender', message);
  }
  if (message.chat?.type !== 'private') return denied('chat-not-private', message);
  if (!Number.isSafeInteger(message.chat.id) || message.chat.id <= 0) {
    return denied('missing-or-invalid-chat', message);
  }
  if (String(sender.id) !== owner.userId) return denied('wrong-user', message);
  if (String(message.chat.id) !== owner.chatId) return denied('wrong-chat', message);
  return { ok: true, reason: 'authorized', message };
}

export function createPairingRequest(db, userId, chatId, clock = Date.now) {
  const storedUserId = numericTelegramId(userId, 'user id');
  const storedChatId = numericTelegramId(chatId, 'chat id');
  const createdAt = nowFrom(clock);
  const expiresAt = new Date(createdAt.getTime() + PAIRING_TTL_MS);

  if (db.prepare('SELECT 1 FROM owner_binding WHERE singleton = 1').get()) {
    throw new Error('owner is already paired');
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = String(randomInt(100_000_000)).padStart(8, '0');
    const result = db.prepare(`
      INSERT INTO pairing_requests(code_hash, user_id, chat_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code_hash) DO NOTHING
    `).run(
      pairingCodeHash(code),
      storedUserId,
      storedChatId,
      expiresAt.toISOString(),
      createdAt.toISOString(),
    );
    if (result.changes === 1) return { code, expiresAt: expiresAt.toISOString() };
  }
  throw new Error('could not allocate a unique pairing code');
}

export function approvePairing(db, code, clock = Date.now) {
  if (typeof code !== 'string' || !/^\d{8}$/.test(code)) {
    throw new Error('invalid or already used pairing code');
  }
  const codeHash = pairingCodeHash(code);
  const pairedAt = nowFrom(clock);
  let outcome;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM owner_binding WHERE singleton = 1').get()) {
      outcome = { error: 'owner is already paired' };
    } else {
      const request = db.prepare(`
        SELECT user_id, chat_id, expires_at, created_at
        FROM pairing_requests WHERE code_hash = ?
      `).get(codeHash);
      if (!request) {
        outcome = { error: 'invalid or already used pairing code' };
      } else {
        const createdAt = canonicalIsoTimestamp(request.created_at);
        const expiresAt = canonicalIsoTimestamp(request.expires_at);
        const validRequest = isCanonicalTelegramId(request.user_id)
          && isCanonicalTelegramId(request.chat_id)
          && createdAt !== null
          && expiresAt !== null
          && expiresAt - createdAt === PAIRING_TTL_MS;

        if (!validRequest) {
          db.prepare('DELETE FROM pairing_requests WHERE code_hash = ?').run(codeHash);
          outcome = { error: 'invalid pairing request' };
        } else if (expiresAt <= pairedAt.getTime()) {
          db.prepare('DELETE FROM pairing_requests WHERE code_hash = ?').run(codeHash);
          outcome = { error: 'pairing code has expired' };
        } else {
          db.prepare(`
            INSERT INTO owner_binding(singleton, user_id, chat_id, paired_at)
            VALUES (1, ?, ?, ?)
          `).run(request.user_id, request.chat_id, pairedAt.toISOString());
          db.prepare('DELETE FROM pairing_requests').run();
          outcome = {
            owner: {
              userId: request.user_id,
              chatId: request.chat_id,
              pairedAt: pairedAt.toISOString(),
            },
          };
        }
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  if (outcome.error) throw new Error(outcome.error);
  return outcome.owner;
}
