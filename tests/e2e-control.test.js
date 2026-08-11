import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { ApprovalService } from '../src/security/approval-service.js';
import { authorizeTelegramUpdate } from '../src/security/identity.js';
import { canonicalHash } from '../src/shared/canonical-json.js';
import { TaskService } from '../src/core/task-service.js';

class ControlHarness {
  constructor() {
    this.directory = mkdtempSync(path.join(os.tmpdir(), 'pi-control-e2e-'));
    this.databasePath = path.join(this.directory, 'control.sqlite');
    this.owner = { userId: '10001', chatId: '10001' };
    this.services = new Map([['nginx', true], ['cloudflared', true]]);
    this.openCore();
  }

  openCore() {
    this.db = openDatabase(this.databasePath);
    this.tasks = new TaskService(this.db);
  }

  stop(name) { this.services.set(name, false); }

  restartCore() {
    this.db.close();
    this.openCore();
  }

  ownerMessage(text, { userId = 10001, chatId = 10001, requestId = `e2e-${Date.now()}-${Math.random()}` } = {}) {
    const update = { message: { from: { id: userId }, chat: { id: chatId, type: 'private' }, text } };
    const authorization = authorizeTelegramUpdate(update, this.owner);
    if (!authorization.ok) return { acceptedByTelegramGateway: false, usedPortal: false, reason: authorization.reason };
    const task = this.tasks.submit({ requestId, channel: 'telegram', text, attachments: [] });
    return { acceptedByTelegramGateway: true, usedPortal: false, task };
  }

  close() {
    this.db.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

test('website outage does not stop an owner Telegram repair task', () => {
  const harness = new ControlHarness();
  try {
    harness.stop('nginx');
    harness.stop('cloudflared');
    const result = harness.ownerMessage('repair the websites');
    assert.equal(result.acceptedByTelegramGateway, true);
    assert.equal(result.usedPortal, false);
    assert.equal(result.task.source, 'telegram');
  } finally { harness.close(); }
});

test('an unpaired Telegram account cannot submit or learn task state', () => {
  const harness = new ControlHarness();
  try {
    const result = harness.ownerMessage('read server status', { userId: 20002, chatId: 20002 });
    assert.equal(result.acceptedByTelegramGateway, false);
    assert.equal(result.reason, 'wrong-user');
    assert.equal(harness.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 0);
  } finally { harness.close(); }
});

test('approval rejects pre-grant, expired and changed operations and consumes one exact grant', async () => {
  const harness = new ControlHarness();
  let now = Date.parse('2026-08-03T00:00:00.000Z');
  try {
    const approvals = new ApprovalService({
      db: harness.db,
      passwordRecord: 'test-record',
      verifyPassword: async (password) => password === 'correct',
      clock: () => now,
      ttlMs: 120_000,
    });
    const operation = canonicalHash({ toolName: 'Bash', toolInput: { command: 'rm /tmp/pi-control-fixture' } });
    const changed = canonicalHash({ toolName: 'Bash', toolInput: { command: 'rm /tmp/changed-fixture' } });
    const request = approvals.request({ taskId: 'fixture-task', ownerId: harness.owner.userId, operationHash: operation });
    assert.equal(approvals.consume(request.id, { taskId: 'fixture-task', ownerId: harness.owner.userId, operationHash: operation }), false);
    assert.equal(await approvals.grantWithPassword(request.id, 'correct'), true);
    assert.equal(approvals.consume(request.id, { taskId: 'fixture-task', ownerId: harness.owner.userId, operationHash: changed }), false);
    assert.equal(approvals.consume(request.id, { taskId: 'fixture-task', ownerId: harness.owner.userId, operationHash: operation }), true);
    assert.equal(approvals.consume(request.id, { taskId: 'fixture-task', ownerId: harness.owner.userId, operationHash: operation }), false);

    const expired = approvals.request({ taskId: 'expired-task', ownerId: harness.owner.userId, operationHash: operation });
    now += 120_001;
    assert.equal(await approvals.grantWithPassword(expired.id, 'correct'), false);
    assert.equal(harness.db.prepare('SELECT state FROM approvals WHERE id = ?').get(expired.id).state, 'expired');
  } finally { harness.close(); }
});

test('raw global history survives a core restart in sequence order', () => {
  const harness = new ControlHarness();
  try {
    harness.ownerMessage('first repair request', { requestId: 'restart-one' });
    harness.ownerMessage('second repair request', { requestId: 'restart-two' });
    harness.restartCore();
    const history = harness.tasks.listEvents(0, 100).events;
    assert.deepEqual(history.map(({ sequence, channel, body }) => ({ sequence, channel, body })), [
      { sequence: 1, channel: 'telegram', body: 'first repair request' },
      { sequence: 2, channel: 'telegram', body: 'second repair request' },
    ]);
  } finally { harness.close(); }
});
