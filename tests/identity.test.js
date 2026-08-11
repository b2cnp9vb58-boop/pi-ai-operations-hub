import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import {
  approvePairing,
  authorizeTelegramUpdate,
  createPairingRequest,
} from '../src/security/identity.js';

const START = new Date('2030-01-02T03:04:05.000Z');

function messageUpdate(userId, chatId, type = 'private') {
  return {
    message: {
      from: { id: userId },
      chat: { id: chatId, type },
      text: '/status',
    },
  };
}

test('only the exact numeric owner in the paired private chat is authorized', () => {
  const owner = { userId: '123', chatId: '456' };

  assert.equal(authorizeTelegramUpdate(messageUpdate(123, 456), owner).ok, true);
  assert.equal(authorizeTelegramUpdate(messageUpdate(124, 456), owner).ok, false);
  assert.equal(authorizeTelegramUpdate(messageUpdate(123, 457), owner).ok, false);
  assert.equal(authorizeTelegramUpdate(messageUpdate(123, 456, 'group'), owner).ok, false);
  assert.equal(authorizeTelegramUpdate(messageUpdate('123', 456), owner).ok, false);
  assert.equal(authorizeTelegramUpdate({ message: { chat: { id: 456, type: 'private' } } }, owner).ok, false);
});

test('a callback query uses its own sender and the private message chat', () => {
  const update = {
    callback_query: {
      from: { id: 123 },
      message: { chat: { id: 456, type: 'private' } },
      data: 'cancel',
    },
  };

  const result = authorizeTelegramUpdate(update, { userId: '123', chatId: '456' });

  assert.equal(result.ok, true);
  assert.equal(result.message, update.callback_query.message);
});

test('pairing stores only a hash of an eight-digit code and approves exact numeric ids', () => {
  const db = openDatabase(':memory:');
  try {
    const request = createPairingRequest(db, 123, 456, () => START);

    assert.match(request.code, /^\d{8}$/);
    assert.equal(request.expiresAt, '2030-01-02T03:14:05.000Z');
    const stored = db.prepare('SELECT * FROM pairing_requests').get();
    assert.equal(stored.code_hash, createHash('sha256').update(request.code).digest('hex'));
    assert.equal(JSON.stringify(stored).includes(request.code), false);
    assert.equal(stored.user_id, '123');
    assert.equal(stored.chat_id, '456');

    assert.deepEqual(approvePairing(db, request.code, () => new Date(START.getTime() + 599_999)), {
      userId: '123',
      chatId: '456',
      pairedAt: '2030-01-02T03:14:04.999Z',
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count, 0);
    assert.throws(() => approvePairing(db, request.code, () => START), /invalid|used|already paired/i);
  } finally {
    db.close();
  }
});

test('pairing expires at ten minutes and an expired code cannot be reused', () => {
  const db = openDatabase(':memory:');
  try {
    const request = createPairingRequest(db, 123, 456, () => START);
    const atExpiry = new Date(START.getTime() + 600_000);

    assert.throws(() => approvePairing(db, request.code, () => atExpiry), /expired/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM owner_binding').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count, 0);
    assert.throws(() => approvePairing(db, request.code, () => START), /invalid|used/i);
  } finally {
    db.close();
  }
});

test('malformed pairing rows are consumed without creating an owner', async (t) => {
  const malformedRows = [
    { name: 'non-numeric user id', column: 'user_id', value: 'owner' },
    { name: 'negative chat id', column: 'chat_id', value: '-9' },
    { name: 'unsafe integer user id', column: 'user_id', value: String(Number.MAX_SAFE_INTEGER + 1) },
    { name: 'non-canonical creation date', column: 'created_at', value: '2030-01-02T03:04:05Z' },
    { name: 'non-canonical expiry date', column: 'expires_at', value: '2030-01-02T03:14:05Z' },
    { name: 'incorrect pairing TTL', column: 'expires_at', value: '2030-01-02T03:14:04.999Z' },
  ];

  for (const malformed of malformedRows) {
    await t.test(malformed.name, () => {
      const db = openDatabase(':memory:');
      try {
        const request = createPairingRequest(db, 123, 456, () => START);
        db.prepare(`UPDATE pairing_requests SET ${malformed.column} = ?`).run(malformed.value);

        assert.throws(() => approvePairing(db, request.code, () => START), /invalid/i);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM owner_binding').get().count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pairing_requests').get().count, 0);
        assert.throws(() => approvePairing(db, request.code, () => START), /invalid|used/i);
      } finally {
        db.close();
      }
    });
  }
});

test('approving one request permanently prevents a second owner binding', () => {
  const db = openDatabase(':memory:');
  try {
    const first = createPairingRequest(db, 123, 456, () => START);
    const second = createPairingRequest(db, 789, 987, () => START);

    approvePairing(db, first.code, () => START);

    assert.throws(() => approvePairing(db, second.code, () => START), /owner.*paired/i);
    const owner = db.prepare('SELECT user_id, chat_id FROM owner_binding').get();
    assert.equal(owner.user_id, '123');
    assert.equal(owner.chat_id, '456');
  } finally {
    db.close();
  }
});

test('pairing rejects non-numeric and non-private Telegram identities', () => {
  const db = openDatabase(':memory:');
  try {
    assert.throws(() => createPairingRequest(db, 'user-123', 456, () => START), /user/i);
    assert.throws(() => createPairingRequest(db, 123, -9, () => START), /chat/i);
  } finally {
    db.close();
  }
});
