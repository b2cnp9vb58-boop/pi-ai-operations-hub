import http from 'node:http';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoreServer } from '../src/core/server.js';
import { TaskService } from '../src/core/task-service.js';
import { openDatabase } from '../src/db/database.js';
import { ClaudeRunner } from '../src/core/claude-runner.js';
import { ConversationService } from '../src/core/conversation-service.js';
import { fileURLToPath } from 'node:url';

const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

const keys = Object.freeze({
  telegram: 't'.repeat(32),
  web: 'w'.repeat(32),
  admin: 'a'.repeat(32),
  hook: 'h'.repeat(32),
  weixin: 'x'.repeat(32),
});

function config(overrides = {}) {
  return { host: '127.0.0.1', port: 4330, clientKeys: keys, ...overrides };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4330, '127.0.0.1', resolve);
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(path, { method = 'GET', key, body, rawBody, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const requestHeaders = { ...headers };
    if (key !== undefined) requestHeaders['X-Pi-Control-Key'] = key;
    if (payload !== undefined) {
      requestHeaders['Content-Type'] ??= 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port: 4330, path, method, headers: requestHeaders, agent: false }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.end(payload);
    else req.end();
  });
}

async function withServer(run, extendServices = () => ({})) {
  const db = openDatabase(':memory:');
  const taskService = new TaskService(db);
  const server = createCoreServer({
    config: config(),
    db,
    services: {
      taskService,
      hookService: {
        handleApprovalAction(input) { return { ...input, state: input.action === 'approve' ? 'waiting_password' : 'cancelled' }; },
        isPendingPassword(ownerId) { return ownerId === '123'; },
        submitPassword({ ownerId, password }) { return { ok: ownerId === '123' && password === 'secret' }; },
      },
      preToolUse(input) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }, toolUseId: input.toolUseId };
      },
      ...extendServices({ db, taskService }),
    },
  });
  try {
    await listen(server);
    await run({ db, server, taskService });
  } finally {
    await close(server);
    db.close();
  }
}

test('message authentication maps each key to exactly one channel and persists before 202', async () => {
  await withServer(async ({ db }) => {
    const impersonation = await request('/v1/messages', {
      method: 'POST',
      key: keys.telegram,
      body: { requestId: 'r1', channel: 'web', text: 'status', attachments: [] },
    });
    assert.equal(impersonation.status, 403);

    const unauthenticated = await request('/v1/messages', {
      method: 'POST',
      key: 'not-a-real-client-key',
      body: { requestId: 'r2', channel: 'telegram', text: 'status', attachments: [] },
    });
    assert.equal(unauthenticated.status, 401);

    const accepted = await request('/v1/messages', {
      method: 'POST',
      key: keys.telegram,
      body: { requestId: 'r3', channel: 'telegram', text: '检查', attachments: [] },
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(Object.keys(accepted.body), ['data']);
    assert.deepEqual(Object.keys(accepted.body.data).sort(), ['eventCursor', 'state', 'taskId']);
    assert.equal(accepted.body.data.state, 'queued');
    assert.equal(accepted.body.data.eventCursor, 1);
    assert.equal(db.prepare('SELECT state FROM tasks WHERE id = ?').get(accepted.body.data.taskId).state, 'queued');
    assert.equal(db.prepare('SELECT body FROM messages WHERE task_id = ?').get(accepted.body.data.taskId).body, '检查');
  });
});

test('cancel API interrupts the active Claude process but never signals a queued task', async () => {
  let runner;
  let cancelCalls = 0;
  await withServer(async ({ taskService }) => {
    const active = taskService.submit({ requestId: 'live-cancel', channel: 'telegram', text: 'hang', attachments: [] });
    taskService.claimNext();
    runner = new ClaudeRunner({
      conversationService: new ConversationService(taskService.db), taskService,
      config: { claudeBin: process.execPath, claudeCwd: process.cwd() }, fixtureArgs: [fakeClaude, '--fake-hang'], timeoutMs: 500,
    });
    const running = runner.run({ id: active.id, text: 'hang', channel: 'telegram' }, {}, {});
    const cancelled = await request(`/v1/tasks/${active.id}/cancel`, { method: 'POST', key: keys.admin, body: {} });
    assert.equal(cancelled.status, 202);
    assert.equal(cancelled.body.data.runnerCancellation, 'signalled');
    assert.equal((await running).stopReason, 'cancelled');

    const queued = taskService.submit({ requestId: 'queued-cancel', channel: 'telegram', text: 'queued', attachments: [] });
    const queuedResult = await request(`/v1/tasks/${queued.id}/cancel`, { method: 'POST', key: keys.admin, body: {} });
    assert.equal(queuedResult.body.data.state, 'interrupted');
    assert.equal(cancelCalls, 1);
  }, () => ({ claudeRunner: { cancelSafely(taskId) { cancelCalls += 1; return runner?.cancelSafely(taskId) ?? false; } } }));
});

test('message retries acknowledge the original task without duplicate persistence', async () => {
  await withServer(async ({ db }) => {
    const options = {
      method: 'POST',
      key: keys.web,
      body: { requestId: 'web-r1', channel: 'web', text: 'hello', attachments: [] },
    };
    const first = await request('/v1/messages', options);
    const second = await request('/v1/messages', options);

    assert.equal(first.status, 202);
    assert.deepEqual(second.body, first.body);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
  });
});

test('message request id payload conflicts return 409 without duplicate persistence', async () => {
  await withServer(async ({ db }) => {
    const first = await request('/v1/messages', {
      method: 'POST', key: keys.web,
      body: { requestId: 'conflict-r1', channel: 'web', text: 'original', attachments: [{ id: 'a1' }] },
    });
    const conflict = await request('/v1/messages', {
      method: 'POST', key: keys.web,
      body: { requestId: 'conflict-r1', channel: 'web', text: 'changed', attachments: [{ id: 'a1' }] },
    });

    assert.equal(first.status, 202);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'request_conflict');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 1);
  });
});

test('JSON endpoints reject malformed, unknown-field and oversized bodies without persistence', async () => {
  await withServer(async ({ db }) => {
    const malformed = await request('/v1/messages', { method: 'POST', key: keys.telegram, rawBody: '{"requestId":' });
    assert.equal(malformed.status, 400);

    const unknown = await request('/v1/messages', {
      method: 'POST', key: keys.telegram,
      body: { requestId: 'r1', channel: 'telegram', text: 'x', attachments: [], admin: true },
    });
    assert.equal(unknown.status, 400);

    const oversized = await request('/v1/messages', {
      method: 'POST', key: keys.telegram,
      body: { requestId: 'large', channel: 'telegram', text: 'x'.repeat(1024 * 1024), attachments: [] },
    });
    assert.equal(oversized.status, 413);

    const unknownQuery = await request('/v1/messages?admin=true', {
      method: 'POST', key: keys.telegram,
      body: { requestId: 'query', channel: 'telegram', text: 'x', attachments: [] },
    });
    assert.equal(unknownQuery.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  });
});

test('JSON endpoints reject invalid UTF-8 bytes without persistence', async () => {
  await withServer(async ({ db }) => {
    const rawBody = Buffer.concat([
      Buffer.from('{"requestId":"bad-utf8","channel":"telegram","text":"'),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('","attachments":[]}'),
    ]);
    const response = await request('/v1/messages', { method: 'POST', key: keys.telegram, rawBody });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_json');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM messages').get().count, 0);
  });
});

test('events, cancellation and health use authenticated stable response contracts', async () => {
  await withServer(async () => {
    const submitted = await request('/v1/messages', {
      method: 'POST', key: keys.telegram,
      body: { requestId: 'r1', channel: 'telegram', text: 'check', attachments: [] },
    });
    const taskId = submitted.body.data.taskId;

    const events = await request('/v1/events?after=0&limit=10', { key: keys.web });
    assert.equal(events.status, 200);
    assert.equal(events.body.data.eventCursor, 1);
    assert.equal(events.body.data.events[0].taskId, taskId);

    const cancelled = await request(`/v1/tasks/${taskId}/cancel`, { method: 'POST', key: keys.admin, body: {} });
    assert.equal(cancelled.status, 202);
    assert.deepEqual(cancelled.body.data, { taskId, state: 'interrupted' });

    const health = await request('/v1/health', { key: keys.telegram });
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { data: { status: 'ok' } });
  });
});

test('WeChat can poll only its own read-only task and cannot inspect events or cancel work', async () => {
  await withServer(async ({ taskService }) => {
    const telegramTask = taskService.submit({ requestId: 'telegram-private', channel: 'telegram', text: 'private', attachments: [] });
    const weixinSubmission = await request('/v1/messages', {
      method: 'POST', key: keys.weixin,
      body: { requestId: 'weixin-read', channel: 'weixin', text: 'summarize the current state', attachments: [] },
    });
    assert.equal(weixinSubmission.status, 202);
    const weixinTaskId = weixinSubmission.body.data.taskId;

    assert.equal((await request('/v1/events?after=0&limit=10', { key: keys.weixin })).status, 403);
    assert.equal((await request(`/v1/tasks/${telegramTask.id}`, { key: keys.weixin })).status, 404);
    assert.equal((await request(`/v1/tasks/${telegramTask.id}/cancel`, { method: 'POST', key: keys.weixin, body: {} })).status, 403);
    assert.equal((await request(`/v1/tasks/${weixinTaskId}`, { key: keys.weixin })).status, 200);
  });
});

test('the hook route accepts only the hook key and exact hook envelope', async () => {
  await withServer(async () => {
    const hookBody = { sessionId: 's1', taskId: 't1', toolName: 'Read', toolInput: { file_path: '/tmp/a' }, toolUseId: 'u1' };
    const wrongClient = await request('/v1/hooks/pre-tool-use', { method: 'POST', key: keys.telegram, body: hookBody });
    assert.equal(wrongClient.status, 403);

    const accepted = await request('/v1/hooks/pre-tool-use', { method: 'POST', key: keys.hook, body: hookBody });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.toolUseId, 'u1');

    const extraField = await request('/v1/hooks/pre-tool-use', {
      method: 'POST', key: keys.hook, body: { ...hookBody, bypass: true },
    });
    assert.equal(extraField.status, 400);

    const extraQuery = await request('/v1/hooks/pre-tool-use?bypass=true', {
      method: 'POST', key: keys.hook, body: hookBody,
    });
    assert.equal(extraQuery.status, 400);
  });
});

test('Telegram-only approval and password routes never echo the password', async () => {
  await withServer(async () => {
    const action = await request('/v1/approvals/action', { method: 'POST', key: keys.telegram,
      body: { action: 'approve', approvalId: 'a1', ownerId: '123' } });
    assert.equal(action.status, 200);
    assert.equal(action.body.data.state, 'waiting_password');

    const forbidden = await request('/v1/approvals/action', { method: 'POST', key: keys.web,
      body: { action: 'approve', approvalId: 'a1', ownerId: '123' } });
    assert.equal(forbidden.status, 403);

    const pending = await request('/v1/approvals/pending-password?ownerId=123', { key: keys.telegram });
    assert.deepEqual(pending.body, { data: { pending: true } });

    const password = await request('/v1/approvals/password', { method: 'POST', key: keys.telegram,
      body: { ownerId: '123', password: 'secret' } });
    assert.deepEqual(password.body, { data: { ok: true } });
    assert.equal(JSON.stringify(password.body).includes('secret'), false);
  });
});

test('malformed task path encoding is rejected as client input', async () => {
  await withServer(async () => {
    const response = await request('/v1/tasks/%ZZ/cancel', { method: 'POST', key: keys.admin, body: {} });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'invalid_path');
  });
});

test('authenticated clients can poll one task without exposing internal keys', async () => {
  await withServer(async ({ taskService }) => {
    const task = taskService.submit({ requestId: 'poll-task', channel: 'web', text: 'check', attachments: [] });
    const polled = await request(`/v1/tasks/${task.id}`, { key: keys.web });
    assert.equal(polled.status, 200);
    assert.deepEqual(Object.keys(polled.body.data).sort(), [
      'cancelRequested', 'createdAt', 'resultSummary', 'state', 'taskId', 'updatedAt',
    ]);
    assert.equal(polled.body.data.taskId, task.id);
    assert.equal(JSON.stringify(polled.body).includes(keys.web), false);
    assert.equal((await request(`/v1/tasks/${task.id}`, { key: keys.hook })).status, 403);
    assert.equal((await request('/v1/tasks/missing', { key: keys.web })).status, 404);
  });
});

test('core server rejects any bind configuration outside fixed loopback endpoint', () => {
  const db = openDatabase(':memory:');
  try {
    for (const invalid of [config({ host: '0.0.0.0' }), config({ host: 'localhost' }), config({ port: 4331 })]) {
      assert.throws(() => createCoreServer({ config: invalid, db, services: {} }), /127\.0\.0\.1:4330/);
    }
  } finally {
    db.close();
  }
});
