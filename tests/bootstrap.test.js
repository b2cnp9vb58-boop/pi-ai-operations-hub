import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/db/database.js';
import { appendOutbox } from '../src/db/repositories.js';

const root = path.resolve(import.meta.dirname, '..');

const keys = {
  PI_CONTROL_TELEGRAM_KEY: 't'.repeat(32),
  PI_CONTROL_WEB_KEY: 'w'.repeat(32),
  PI_CONTROL_ADMIN_KEY: 'a'.repeat(32),
  PI_CONTROL_HOOK_KEY: 'h'.repeat(32),
  PI_CONTROL_WEIXIN_KEY: 'x'.repeat(32),
};

test('core bootstrap opens the real database, announces ready and stays serving until stopped', async () => {
  const { startCoreProcess } = await import('../bin/pi-control-core.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-core-bootstrap-'));
  let ready = 0;
  const runtime = await startCoreProcess({
    env: {
      ...keys,
      PI_CONTROL_DATA_DIR: directory,
      PI_CONTROL_PASSWORD_RECORD: 'test-only-record',
      PI_CONTROL_CLAUDE_BIN: process.execPath,
      PI_CONTROL_CLAUDE_CWD: directory,
    },
    notifier: { async status() {}, async ready() { ready += 1; }, async watchdog() {} },
    workerIntervalMs: 10_000,
  });
  try {
    const response = await fetch('http://127.0.0.1:4330/v1/health', {
      headers: { 'X-Pi-Control-Key': keys.PI_CONTROL_ADMIN_KEY },
    });
    assert.equal(response.status, 200);
    assert.equal(ready, 1);
    assert.equal(runtime.server.listening, true);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram bootstrap announces ready and keeps long-polling until explicitly stopped', async () => {
  const { startTelegramProcess } = await import('../bin/telegram-control.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-telegram-bootstrap-'));
  let ready = 0;
  let polls = 0;
  const client = {
    async getUpdates({ signal }) {
      polls += 1;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw signal.reason;
    },
    async sendMessage() {},
    async deleteMessage() {},
  };
  const runtime = await startTelegramProcess({
    env: {
      TELEGRAM_BOT_TOKEN: `123456:${'x'.repeat(30)}`,
      PI_CONTROL_TELEGRAM_KEY: keys.PI_CONTROL_TELEGRAM_KEY,
      PI_CONTROL_DATA_DIR: directory,
    },
    client,
    notifier: { async ready() { ready += 1; }, async watchdog() {} },
    sleep: async () => {},
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(ready, 1);
    assert.equal(polls, 1);
    assert.equal(runtime.stopped, false);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram bootstrap delivers durable task results while long polling is still waiting', async () => {
  const { startTelegramProcess } = await import('../bin/telegram-control.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-telegram-delivery-bootstrap-'));
  const database = openDatabase(path.join(directory, 'conversations.sqlite'));
  try {
    database.prepare(`
      INSERT INTO owner_binding(singleton, user_id, chat_id, paired_at) VALUES (1, ?, ?, ?)
    `).run('12937185', '456', new Date().toISOString());
    appendOutbox(database, {
      kind: 'telegram.task.result',
      payload: { taskId: 'bootstrap-task', status: 'completed', summary: 'durable bootstrap result' },
    });
    database.prepare("UPDATE outbox SET state = 'sending', attempts = 1").run();
  } finally {
    database.close();
  }

  const sent = [];
  const client = {
    async getUpdates({ signal }) {
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw signal.reason;
    },
    async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: 1 }; },
    async deleteMessage() {},
  };
  const runtime = await startTelegramProcess({
    env: {
      TELEGRAM_BOT_TOKEN: `123456:${'x'.repeat(30)}`,
      PI_CONTROL_TELEGRAM_KEY: keys.PI_CONTROL_TELEGRAM_KEY,
      PI_CONTROL_DATA_DIR: directory,
    },
    client,
    notifier: { async ready() {}, async watchdog() {} },
    deliveryIntervalMs: 10,
  });
  try {
    const deadline = Date.now() + 500;
    while (sent.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, 456);
    assert.match(sent[0].text, /durable bootstrap result/);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test('core entrypoint stays active when launched through the current release symlink', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-core-symlink-'));
  const current = path.join(directory, 'current');
  const passwordFile = path.join(directory, 'password.scrypt');
  await symlink(root, current, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(passwordFile, 'test-only-record', 'utf8');

  const child = spawn(process.execPath, [path.join(current, 'bin', 'pi-control-core.mjs')], {
    env: {
      ...process.env,
      ...keys,
      PI_CONTROL_DATA_DIR: directory,
      PI_CONTROL_PASSWORD_FILE: passwordFile,
      PI_CONTROL_CLAUDE_BIN: process.execPath,
      PI_CONTROL_CLAUDE_CWD: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (child.exitCode !== null) break;
      try {
        response = await fetch('http://127.0.0.1:4330/v1/health', {
          headers: { 'X-Pi-Control-Key': keys.PI_CONTROL_ADMIN_KEY },
        });
        if (response.status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(response?.status, 200, `symlinked entrypoint exited or never listened: ${stderr}`);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test('core reads the high-risk password from its systemd credential directory', async () => {
  const { startCoreProcess } = await import('../bin/pi-control-core.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-core-credential-'));
  const credentials = path.join(directory, 'credentials');
  await symlink(directory, credentials, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(directory, 'high-risk-password'), 'test-only-record', 'utf8');
  const runtime = await startCoreProcess({
    env: {
      ...keys,
      PI_CONTROL_DATA_DIR: directory,
      PI_CONTROL_PASSWORD_FILE: path.join(directory, 'must-not-be-read'),
      CREDENTIALS_DIRECTORY: credentials,
      PI_CONTROL_CLAUDE_BIN: process.execPath,
      PI_CONTROL_CLAUDE_CWD: directory,
    },
    notifier: { async status() {}, async ready() {}, async watchdog() {} },
    workerIntervalMs: 10_000,
  });
  try {
    const response = await fetch('http://127.0.0.1:4330/v1/health', {
      headers: { 'X-Pi-Control-Key': keys.PI_CONTROL_ADMIN_KEY },
    });
    assert.equal(response.status, 200);
  } finally {
    await runtime.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
