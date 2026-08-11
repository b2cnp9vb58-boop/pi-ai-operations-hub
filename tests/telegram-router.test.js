import assert from 'node:assert/strict';
import test from 'node:test';
import { submitCoreMessage } from '../src/telegram/main.js';
import { processBatch, routeUpdate } from '../src/telegram/update-router.js';

const owner = Object.freeze({ userId: '123', chatId: '456' });

function ownerMessage(text, extra = {}) {
  return { from: { id: 123 }, chat: { id: 456, type: 'private' }, text, ...extra };
}

function otherUserMessage(text) {
  return { from: { id: 999 }, chat: { id: 456, type: 'private' }, text };
}

test('another account never reaches the core', async () => {
  let submissions = 0;
  const result = await routeUpdate({ update_id: 8, message: otherUserMessage('shutdown') }, {
    owner,
    submit: async () => { submissions += 1; return { ok: true }; },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.kind, 'ignored');
  assert.equal(submissions, 0);
});

test('mixed message and callback payloads are ignored before any owner-sensitive handler', async () => {
  const submissions = [];
  const passwordChecks = [];
  const context = {
    owner,
    submit: async (envelope) => { submissions.push(envelope); return { ok: true }; },
    isPendingPassword: (update) => { passwordChecks.push(update.update_id); return true; },
    submitPassword: async () => ({ ok: true }),
  };
  const attackerCallback = {
    from: { id: 999 },
    message: { chat: { id: 456, type: 'private' } },
    data: 'attacker-action',
  };
  const ownerCallback = {
    from: { id: 123 },
    message: { chat: { id: 456, type: 'private' } },
    data: 'owner-action',
  };
  const mixedUpdates = [
    { update_id: 31, message: ownerMessage('owner text'), callback_query: attackerCallback },
    { update_id: 32, message: otherUserMessage('attacker text'), callback_query: ownerCallback },
    { update_id: 33, message: ownerMessage('owner text'), callback_query: ownerCallback },
  ];

  for (const update of mixedUpdates) {
    const result = await routeUpdate(update, context);
    assert.equal(result.kind, 'ignored');
  }

  assert.deepEqual(submissions, []);
  assert.deepEqual(passwordChecks, []);
});

test('a mixed pre-pairing update cannot create a pairing request', async () => {
  let pairingRequests = 0;
  const result = await routeUpdate({
    update_id: 34,
    message: ownerMessage('/start'),
    callback_query: {
      from: { id: 999 },
      message: { chat: { id: 456, type: 'private' } },
      data: 'attacker-action',
    },
  }, {
    owner: null,
    createPairingRequest: () => { pairingRequests += 1; return { code: '12345678' }; },
  });

  assert.equal(result.kind, 'ignored');
  assert.equal(pairingRequests, 0);
});

test('before pairing only a private /start creates a pairing request', async () => {
  const requests = [];
  const notices = [];
  const context = {
    owner: null,
    db: {},
    createPairingRequest: (_db, userId, chatId) => {
      requests.push({ userId, chatId });
      return { code: '12345678', expiresAt: '2030-01-01T00:10:00.000Z' };
    },
    sendMessage: async (chatId, text) => { notices.push({ chatId, text }); return true; },
  };

  const ignored = await routeUpdate({ update_id: 1, message: ownerMessage('status') }, context);
  const paired = await routeUpdate({ update_id: 2, message: ownerMessage('/start') }, context);
  const groupStart = await routeUpdate({ update_id: 3, message: { ...ownerMessage('/start'), chat: { id: -1, type: 'group' } } }, context);

  assert.equal(ignored.kind, 'ignored');
  assert.equal(paired.kind, 'pairing-request');
  assert.equal(groupStart.kind, 'ignored');
  assert.deepEqual(requests, [{ userId: 123, chatId: 456 }]);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /12345678/);
});

test('the exact owner routes text, attachment metadata, callback data, and pending passwords separately', async () => {
  const submissions = [];
  const passwords = [];
  const context = {
    owner,
    submit: async (envelope) => { submissions.push(envelope); return { ok: true }; },
    isPendingPassword: (update) => update.update_id === 5,
    submitPassword: async (value) => { passwords.push(value); return { ok: true }; },
  };

  for (const update of [
    { update_id: 1, message: ownerMessage('status') },
    { update_id: 2, message: ownerMessage(undefined, { photo: [{ file_id: 'photo-1' }], caption: 'look' }) },
    { update_id: 3, message: ownerMessage(undefined, { document: { file_id: 'document-1', file_name: 'a.txt', mime_type: 'text/plain', file_size: 4 } }) },
    { update_id: 4, callback_query: { from: { id: 123 }, message: { chat: { id: 456, type: 'private' } }, data: 'cancel:abc' } },
    { update_id: 5, message: ownerMessage('separate-password') },
  ]) await routeUpdate(update, context);

  assert.deepEqual(submissions, [
    { requestId: 'telegram:1', channel: 'telegram', text: 'status', attachments: [] },
    { requestId: 'telegram:2', channel: 'telegram', text: 'look', attachments: [{ kind: 'photo', fileId: 'photo-1' }] },
    { requestId: 'telegram:3', channel: 'telegram', text: '[document: a.txt]', attachments: [{ kind: 'document', fileId: 'document-1', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 4 }] },
    { requestId: 'telegram:4', channel: 'telegram', text: 'cancel:abc', attachments: [] },
  ]);
  assert.deepEqual(passwords, [{ update: 5, ownerId: '123', password: 'separate-password' }]);
});

test('approval callbacks bypass ordinary chat and the next password is deleted after verification', async () => {
  const actions = [];
  const passwords = [];
  const deleted = [];
  const context = {
    owner,
    submit: async () => { throw new Error('approval data must not enter ordinary chat'); },
    submitApprovalAction: async (value) => { actions.push(value); return { ok: true }; },
    isPendingPassword: async () => true,
    submitPassword: async (value) => { passwords.push(value); return { ok: true }; },
    deletePasswordMessage: async (chatId, messageId) => deleted.push({ chatId, messageId }),
  };
  const approvalId = '123e4567-e89b-12d3-a456-426614174000';
  const callback = await routeUpdate({
    update_id: 60,
    callback_query: { from: { id: 123 }, message: { chat: { id: 456, type: 'private' } }, data: `approve:${approvalId}` },
  }, context);
  const password = await routeUpdate({
    update_id: 61,
    message: ownerMessage('secret-value', { message_id: 901 }),
  }, context);

  assert.equal(callback.kind, 'approval-action');
  assert.equal(password.kind, 'pending-password');
  assert.deepEqual(actions, [{ action: 'approve', approvalId, ownerId: '123' }]);
  assert.deepEqual(passwords, [{ update: 61, ownerId: '123', password: 'secret-value' }]);
  assert.deepEqual(deleted, [{ chatId: 456, messageId: 901 }]);
});

test('accepted password update is durably consumed even when Telegram deletion fails', async () => {
  const secret = 'must-never-be-chat-history';
  const recorded = new Set();
  let pending = true;
  let ordinarySubmissions = 0;
  const update = { update_id: 62, message: ownerMessage(secret, { message_id: 902 }) };
  const context = {
    owner,
    offset: 0,
    isPendingPassword: async () => pending,
    submitPassword: async () => { pending = false; return { ok: true }; },
    deletePasswordMessage: async () => { throw new Error('Telegram unavailable'); },
    submit: async () => { ordinarySubmissions += 1; return { ok: true }; },
    hasRecordedUpdate: (id) => recorded.has(id),
    recordUpdate: (id) => { recorded.add(id); },
  };

  const first = await processBatch([update], context);
  const replay = await processBatch([update], context);
  assert.deepEqual(first, { nextOffset: 63, retry: false });
  assert.equal(replay.retry, false);
  assert.equal(recorded.has(62), true);
  assert.equal(ordinarySubmissions, 0);
  assert.equal(JSON.stringify([...recorded]).includes(secret), false);
});

test('offset advances only after core accepts the owner message and duplicate ids process once in order', async () => {
  const submissions = [];
  const recorded = [];
  const updates = [
    { update_id: 8, message: ownerMessage('second') },
    { update_id: 7, message: ownerMessage('first') },
    { update_id: 8, message: ownerMessage('duplicate') },
  ];

  const failed = await processBatch([{ update_id: 7, message: ownerMessage('check') }], {
    owner,
    submit: async () => ({ ok: false }),
  });
  const accepted = await processBatch(updates, {
    owner,
    submit: async (envelope) => { submissions.push(envelope.requestId); return { ok: true }; },
    recordUpdate: (updateId) => { recorded.push(updateId); return true; },
  });

  assert.equal(failed.nextOffset, 7);
  assert.equal(failed.retry, true);
  assert.deepEqual(submissions, ['telegram:7', 'telegram:8']);
  assert.deepEqual(recorded, [7, 8]);
  assert.equal(accepted.nextOffset, 9);
});

test('only the core durable 202 acknowledgement accepts a Telegram submission', async () => {
  const requests = [];
  const config = { coreUrl: 'http://127.0.0.1:4330', coreClientKey: 'local-key' };
  const envelope = { requestId: 'telegram:7', channel: 'telegram', text: 'check', attachments: [] };
  const fetch = async (_url, options) => {
    requests.push(options);
    return { status: 202, text: async () => JSON.stringify({ data: { taskId: 'task-7' } }) };
  };

  assert.deepEqual(await submitCoreMessage(config, envelope, { fetch }), { ok: true });
  assert.deepEqual(await submitCoreMessage(config, envelope, {
    fetch: async () => ({ status: 200, text: async () => JSON.stringify({ data: { taskId: 'task-7' } }) }),
  }), { ok: false });
  assert.equal(requests[0].headers['X-Pi-Control-Key'], 'local-key');
  assert.deepEqual(JSON.parse(requests[0].body), envelope);
});

test('a hanging core POST times out, clears its timer, and keeps the update pending', async () => {
  const config = { coreUrl: 'http://127.0.0.1:4330', coreClientKey: 'local-key' };
  const update = { update_id: 41, message: ownerMessage('keep pending') };
  const timerId = Symbol('core-timeout');
  const cleared = [];
  const timers = {
    setTimeout(callback, milliseconds) {
      assert.equal(milliseconds, 10);
      queueMicrotask(callback);
      return timerId;
    },
    clearTimeout(id) { cleared.push(id); },
  };
  const fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  const submit = (envelope) => submitCoreMessage(config, envelope, { fetch, timeoutMs: 10, timers });

  assert.deepEqual(await submit({ requestId: 'telegram:41', channel: 'telegram', text: 'keep pending', attachments: [] }), { ok: false });
  assert.deepEqual(await processBatch([update], { owner, offset: 41, submit }), {
    nextOffset: 41,
    retry: true,
    result: {
      accepted: false,
      kind: 'core-message',
      envelope: { requestId: 'telegram:41', channel: 'telegram', text: 'keep pending', attachments: [] },
    },
  });
  assert.deepEqual(cleared, [timerId, timerId]);
});

test('a core network error returns an unaccepted result', async () => {
  const config = { coreUrl: 'http://127.0.0.1:4330', coreClientKey: 'local-key' };
  const result = await submitCoreMessage(config, {
    requestId: 'telegram:42', channel: 'telegram', text: 'retry', attachments: [],
  }, {
    fetch: async () => { throw new Error('connection refused'); },
    timeoutMs: 10,
  });

  assert.deepEqual(result, { ok: false });
});

test('a failed owner update is retried with the same request id and persisted duplicates do not resubmit', async () => {
  const update = { update_id: 21, message: ownerMessage('retry me') };
  const requestIds = [];
  let attempt = 0;
  const context = {
    owner,
    offset: 21,
    submit: async (envelope) => {
      requestIds.push(envelope.requestId);
      attempt += 1;
      return { ok: attempt === 2 };
    },
    recordUpdate: () => true,
  };

  assert.equal((await processBatch([update], context)).retry, true);
  assert.deepEqual(await processBatch([update], context), { nextOffset: 22, retry: false });
  const duplicate = await processBatch([update], { ...context, hasRecordedUpdate: () => true });

  assert.deepEqual(requestIds, ['telegram:21', 'telegram:21']);
  assert.deepEqual(duplicate, { nextOffset: 22, retry: false });
});
