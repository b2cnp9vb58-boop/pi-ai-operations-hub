import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import {
  approveWeixinPairing,
  authorizeWeixinSender,
  createWeixinPairingRequest,
} from '../src/weixin/identity.js';

const START = new Date('2030-01-02T03:04:05.000Z');
const OWNER = 'owner-opaque-id@im.wechat';

test('an unpaired WeChat sender is denied', () => {
  const db = openDatabase(':memory:');
  try {
    assert.equal(authorizeWeixinSender(db, OWNER), false);
  } finally {
    db.close();
  }
});

test('a valid one-time code binds only the sender that presents it', () => {
  const db = openDatabase(':memory:');
  try {
    const request = createWeixinPairingRequest(db, () => START);

    assert.match(request.code, /^\d{8}$/);
    const stored = db.prepare('SELECT * FROM weixin_pairing_requests').get();
    assert.equal(stored.code_hash, createHash('sha256').update(request.code).digest('hex'));
    assert.equal(JSON.stringify(stored).includes(request.code), false);

    const bound = approveWeixinPairing(db, request.code, OWNER, () => new Date(START.getTime() + 599_999));
    assert.deepEqual(bound, { userId: OWNER, pairedAt: '2030-01-02T03:14:04.999Z' });
    assert.equal(authorizeWeixinSender(db, OWNER), true);
    assert.equal(authorizeWeixinSender(db, 'other-user@im.wechat'), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM weixin_pairing_requests').get().count, 0);
  } finally {
    db.close();
  }
});

test('the provider sender id is treated as an opaque identifier', () => {
  const db = openDatabase(':memory:');
  try {
    const request = createWeixinPairingRequest(db, () => START);
    const opaqueProviderId = 'wx-user-v2:7e9f2d0a';

    approveWeixinPairing(db, request.code, opaqueProviderId, () => START);
    assert.equal(authorizeWeixinSender(db, opaqueProviderId), true);
    assert.equal(authorizeWeixinSender(db, `${opaqueProviderId}-other`), false);
  } finally {
    db.close();
  }
});

test('expired or reused pairing codes cannot bind a sender', () => {
  const db = openDatabase(':memory:');
  try {
    const request = createWeixinPairingRequest(db, () => START);

    assert.throws(() => approveWeixinPairing(db, request.code, OWNER, () => new Date(START.getTime() + 600_000)), /expired/i);
    assert.equal(authorizeWeixinSender(db, OWNER), false);
    assert.throws(() => approveWeixinPairing(db, request.code, OWNER, () => START), /invalid|used/i);
  } finally {
    db.close();
  }
});

test('an existing WeChat owner prevents issuing a replacement pairing code', () => {
  const db = openDatabase(':memory:');
  try {
    const first = createWeixinPairingRequest(db, () => START);
    approveWeixinPairing(db, first.code, OWNER, () => START);
    assert.throws(() => createWeixinPairingRequest(db, () => START), /already.*paired/i);
    assert.equal(authorizeWeixinSender(db, OWNER), true);
    assert.equal(authorizeWeixinSender(db, 'other-user@im.wechat'), false);
  } finally {
    db.close();
  }
});
