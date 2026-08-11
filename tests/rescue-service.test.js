import assert from 'node:assert/strict';
import test from 'node:test';
import { RescueService } from '../src/core/rescue-service.js';
import { routeUpdate } from '../src/telegram/update-router.js';

const owner = Object.freeze({ userId: '123', chatId: '456' });

function service(overrides = {}) {
  const calls = [];
  const consumed = [];
  const rescue = new RescueService({
    ownerId: owner.userId,
    isPrimaryHealthy: async () => false,
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return { code: 0, stdout: 'ok', stderr: '' };
    },
    approvalService: {
      consume(id, binding) {
        consumed.push({ id, binding });
        return id === 'granted-once';
      },
    },
    ...overrides,
  });
  return { rescue, calls, consumed };
}

test('rescue is owner-only and automatically exits when the primary service recovers', async () => {
  const active = service();
  await assert.rejects(active.rescue.execute('status', { userId: '999' }), /owner/i);
  const recovered = service({ isPrimaryHealthy: async () => true });
  await assert.rejects(recovered.rescue.execute('status', owner), /inactive/i);
  assert.equal(active.calls.length, 0);
  assert.equal(recovered.calls.length, 0);
});

test('fixed read-only rescue actions use argv without a shell and reject command injection', async () => {
  const f = service();
  await f.rescue.execute('logs:nginx.service', owner);
  assert.deepEqual(f.calls, [{
    file: '/usr/bin/journalctl',
    args: ['--no-pager', '-n', '100', '-u', 'nginx.service'],
    options: { shell: false, timeoutMs: 8000 },
  }]);
  await assert.rejects(f.rescue.execute('logs:nginx.service;reboot', owner), /unsupported/i);
  await assert.rejects(f.rescue.execute('restart:unknown.service', owner, { id: 'granted-once', taskId: 't' }), /unsupported/i);
  assert.equal(f.calls.length, 1);
});

test('restart and reboot require a consumed high-risk approval bound to owner and operation', async () => {
  const f = service();
  await assert.rejects(f.rescue.execute('reboot', owner, null), /approval required/i);
  await assert.rejects(f.rescue.execute('restart:nginx.service', owner, { id: 'wrong', taskId: 't1' }), /approval required/i);
  await f.rescue.execute('reboot', owner, { id: 'granted-once', taskId: 't2' });

  assert.equal(f.consumed.length, 2);
  assert.equal(f.consumed[1].binding.ownerId, owner.userId);
  assert.match(f.consumed[1].binding.operationHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.calls.at(-1), {
    file: '/usr/bin/systemctl', args: ['reboot'], options: { shell: false, timeoutMs: 8000 },
  });
});

test('Telegram routes fixed rescue commands only for the owner while rescue mode is active', async () => {
  const actions = [];
  const update = { update_id: 70, message: { from: { id: 123 }, chat: { id: 456, type: 'private' }, text: 'status' } };
  const rescued = await routeUpdate(update, {
    owner,
    rescueActive: async () => true,
    executeRescue: async (action, actor) => { actions.push({ action, actor }); return { ok: true }; },
    submit: async () => { throw new Error('AI path must stay inactive during rescue'); },
  });
  assert.equal(rescued.kind, 'rescue-command');
  assert.deepEqual(actions, [{ action: 'status', actor: owner }]);

  let submitted = 0;
  const normal = await routeUpdate(update, {
    owner,
    rescueActive: async () => false,
    executeRescue: async () => { throw new Error('rescue must auto-exit'); },
    submit: async () => { submitted += 1; return { ok: true }; },
  });
  assert.equal(normal.kind, 'core-message');
  assert.equal(submitted, 1);
});
