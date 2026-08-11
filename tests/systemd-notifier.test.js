import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeCoreRuntime, startWatchdog } from '../src/core/main.js';
import { SystemdNotifier } from '../src/core/systemd-notifier.js';

test('ready status and watchdog use fixed systemd-notify argv', async () => {
  const calls = [];
  const notifier = new SystemdNotifier({
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      queueMicrotask(() => callback(null, '', ''));
      return { kill() {} };
    },
  });
  assert.equal(await notifier.ready(), true);
  assert.equal(await notifier.status('healthy'), true);
  assert.equal(await notifier.watchdog(), true);
  assert.deepEqual(calls.map(({ file, args }) => ({ file, args })), [
    { file: '/usr/bin/systemd-notify', args: ['--ready'] },
    { file: '/usr/bin/systemd-notify', args: ['--status=healthy'] },
    { file: '/usr/bin/systemd-notify', args: ['WATCHDOG=1'] },
  ]);
  assert.ok(calls.every(({ options }) => options.shell === false));
});

test('notifier timeout kills only its child, logs, and never rejects task processing', async () => {
  let childKills = 0;
  const errors = [];
  const notifier = new SystemdNotifier({
    timeoutMs: 10,
    logger: { error: (message) => errors.push(message) },
    execFile() { return { kill() { childKills += 1; } }; },
  });
  assert.equal(await notifier.watchdog(), false);
  assert.equal(childKills, 1);
  assert.equal(errors.length, 1);
});

test('watchdog pings only for healthy state and stopping it never terminates the process', async () => {
  const callbacks = [];
  const cleared = [];
  let healthy = true;
  let pings = 0;
  const handle = startWatchdog({
    notifier: { watchdog: async () => { pings += 1; return true; } },
    isHealthy: async () => healthy,
    intervalMs: 1_000,
    timers: {
      setInterval(callback, milliseconds) { assert.equal(milliseconds, 1_000); callbacks.push(callback); return 'timer'; },
      clearInterval(id) { cleared.push(id); },
    },
  });
  await callbacks[0]();
  assert.equal(pings, 1);
  healthy = false;
  await callbacks[0]();
  assert.equal(pings, 1);
  handle.stop();
  assert.deepEqual(cleared, ['timer']);
});

test('core startup reconciles durable state before announcing ready', async () => {
  const order = [];
  const report = await initializeCoreRuntime({
    recoveryService: {
      reconcileStartup() { order.push('reconcile'); return { database: 'ok' }; },
    },
    notifier: {
      async status(text) { order.push(`status:${text}`); return true; },
      async ready() { order.push('ready'); return true; },
    },
  });
  assert.deepEqual(report, { database: 'ok' });
  assert.deepEqual(order, ['reconcile', 'status:recovery complete', 'ready']);
});
