import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MonitorService, createDefaultProbes } from '../src/core/monitor-service.js';
import { openDatabase } from '../src/db/database.js';
import { appendOutbox } from '../src/db/repositories.js';

function fixture(options = {}) {
  const filename = join(tmpdir(), `pi-control-monitor-${randomUUID()}.sqlite`);
  const db = openDatabase(filename);
  let now = Date.parse('2026-08-03T00:00:00.000Z');
  const monitor = new MonitorService({ db, probes: [], clock: () => now, cooldownMs: 60_000, ...options });
  return {
    db,
    monitor,
    advance: (milliseconds) => { now += milliseconds; },
    cleanup() {
      db.close();
      for (const suffix of ['', '-shm', '-wal']) if (existsSync(`${filename}${suffix}`)) rmSync(`${filename}${suffix}`);
    },
  };
}

function outboxKinds(db) {
  return db.prepare('SELECT kind FROM outbox ORDER BY id').all().map(({ kind }) => kind);
}

test('alert fires after three consecutive failures and recovery fires once', async () => {
  const f = fixture();
  try {
    await f.monitor.observe('nginx', false, { message: 'down' });
    await f.monitor.observe('nginx', false, { message: 'down' });
    assert.deepEqual(outboxKinds(f.db), []);
    await f.monitor.observe('nginx', false, { message: 'down' });
    await f.monitor.observe('nginx', false, { message: 'still down' });
    assert.deepEqual(outboxKinds(f.db), ['alert']);
    await f.monitor.observe('nginx', true, { message: 'active' });
    await f.monitor.observe('nginx', true, { message: 'active' });
    assert.deepEqual(outboxKinds(f.db), ['alert', 'recovery']);
  } finally {
    f.cleanup();
  }
});

test('cooldown suppresses a second flapping alert until it expires', async () => {
  const f = fixture();
  try {
    for (let count = 0; count < 3; count += 1) await f.monitor.observe('grade', false);
    await f.monitor.observe('grade', true);
    for (let count = 0; count < 3; count += 1) await f.monitor.observe('grade', false);
    assert.deepEqual(outboxKinds(f.db), ['alert', 'recovery']);
    f.advance(60_000);
    await f.monitor.observe('grade', false);
    assert.deepEqual(outboxKinds(f.db), ['alert', 'recovery', 'alert']);
  } finally {
    f.cleanup();
  }
});

test('runCycle times out a hanging probe and returns every probe result', async () => {
  const f = fixture({
    timeoutMs: 10,
    probes: [
      { name: 'website:example.org', category: 'website', run: async () => ({ ok: true, detail: '200' }) },
      { name: 'api:application-health', category: 'api', run: async () => new Promise(() => {}) },
    ],
  });
  try {
    const results = await f.monitor.runCycle();
    assert.deepEqual(results.map(({ name, category, ok }) => ({ name, category, ok })), [
      { name: 'website:example.org', category: 'website', ok: true },
      { name: 'api:application-health', category: 'api', ok: false },
    ]);
    assert.match(results[1].detail, /timeout/i);
  } finally {
    f.cleanup();
  }
});

test('overlapping cycles share one flight and emit one incident alert and one recovery', async () => {
  let probeCalls = 0;
  let healthy = false;
  let releaseProbe;
  const probe = {
    name: 'service:nginx',
    category: 'service',
    run: () => {
      probeCalls += 1;
      return new Promise((resolve) => {
        releaseProbe = () => resolve({ ok: healthy, detail: healthy ? 'active' : 'down' });
      });
    },
  };
  const f = fixture({ probes: [probe] });
  try {
    await f.monitor.observe(probe.name, false);
    await f.monitor.observe(probe.name, false);

    const failingFirst = f.monitor.runCycle();
    const failingOverlap = f.monitor.runCycle();
    await Promise.resolve();
    releaseProbe();
    await Promise.all([failingFirst, failingOverlap]);
    assert.strictEqual(failingOverlap, failingFirst);
    assert.equal(probeCalls, 1);
    assert.deepEqual(outboxKinds(f.db), ['alert']);

    healthy = true;
    const recoveryFirst = f.monitor.runCycle();
    const recoveryOverlap = f.monitor.runCycle();
    await Promise.resolve();
    releaseProbe();
    await Promise.all([recoveryFirst, recoveryOverlap]);
    assert.strictEqual(recoveryOverlap, recoveryFirst);
    assert.equal(probeCalls, 2);
    assert.deepEqual(outboxKinds(f.db), ['alert', 'recovery']);
  } finally {
    f.cleanup();
  }
});

test('single-flight lock is released after a failed probe cycle', async () => {
  let calls = 0;
  const f = fixture({
    probes: [{
      name: 'api:core-health', category: 'api', run: async () => {
        calls += 1;
        if (calls === 1) throw new Error('probe failed');
        return { ok: true, detail: 'ok' };
      },
    }],
  });
  try {
    assert.equal((await f.monitor.runCycle())[0].ok, false);
    assert.equal((await f.monitor.runCycle())[0].ok, true);
    assert.equal(calls, 2);
  } finally {
    f.cleanup();
  }
});

test('default probes cover websites services temperature memory disks and local APIs', () => {
  const names = createDefaultProbes().map(({ name }) => name);
  for (const expected of [
    'service:nginx', 'service:cloudflared', 'service:pi-control-core', 'service:telegram-control',
    'service:weixin-control', 'nginx:config', 'cloudflare:metrics', 'port:core',
    'api:core-health', 'vnc:handshake', 'system:temperature',
    'system:memory', 'system:load', 'disk:root', 'disk:usb',
    'website:example.org',
  ]) assert.ok(names.includes(expected), `missing probe ${expected}`);
});

test('root and USB disk probes report mount flags and fail closed on read-only media', async () => {
  const probes = createDefaultProbes({
    readText: async (path) => {
      assert.equal(path, '/proc/mounts');
      return '/dev/root / ext4 rw,relatime 0 0\n/dev/sda1 /media/pi-control/usb ext4 ro,nosuid 0 0\n';
    },
    statfsFile: async () => ({ blocks: 100n, bavail: 50n }),
  });
  const root = await probes.find(({ name }) => name === 'disk:root').run();
  const usb = await probes.find(({ name }) => name === 'disk:usb').run();

  assert.equal(root.ok, true);
  assert.match(root.detail, /rw,relatime/);
  assert.equal(usb.ok, false);
  assert.match(usb.detail, /ro,nosuid/);
});

test('Telegram outage keeps an alert queued while WeChat failure never blocks Telegram success', async () => {
  const f = fixture();
  try {
    appendOutbox(f.db, {
      kind: 'alert',
      payload: { probe: 'nginx' },
      nextAttemptAt: '2026-08-03T00:00:00.000Z',
    });
    let telegramAttempts = 0;
    const telegram = async () => {
      telegramAttempts += 1;
      if (telegramAttempts === 1) throw new Error('telegram unavailable');
    };
    const wechat = async () => { throw new Error('wechat unavailable'); };

    assert.equal(await f.monitor.deliverAlerts({ telegram, wechat }), 0);
    assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'pending');
    f.advance(60_000);
    assert.equal(await f.monitor.deliverAlerts({ telegram, wechat }), 1);
    assert.equal(f.db.prepare('SELECT state FROM outbox').get().state, 'sent');
  } finally {
    f.cleanup();
  }
});
