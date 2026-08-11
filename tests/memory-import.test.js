import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  exportHistory,
  importMemory,
  setTelegramEnabled,
  validateMemory,
} from '../bin/pi-control-admin.mjs';
import { ConversationService } from '../src/core/conversation-service.js';
import { openDatabase } from '../src/db/database.js';

const FIXED_TIME = new Date('2026-08-03T12:34:56.000Z');

test('memory import rejects every supported credential-shaped family without echoing it', () => {
  const unsafe = [
    '-----BEGIN PRIVATE KEY-----',
    'api_key = abcdefghijklmnop',
    'password: correct-horse-battery-staple',
    'Cookie: sessionid=abcdef123456',
    'session_token = abcdef123456',
    'sk-ant-abcdefghijklmnopqrstuvwxyz',
    ['gh', 'p_', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
    ['xox', 'b-', '1234567890-abcdefghijklmnopqrstuvwxyz'].join(''),
    'AKIAIOSFODNN7EXAMPLE',
    ['AI', 'za', 'SyA123456789012345678901234567890'].join(''),
  ];
  for (const value of unsafe) {
    assert.throws(() => validateMemory(`safe prefix\n${value}\nsafe suffix`), (error) => {
      assert.match(error.message, /secret-shaped/);
      assert.equal(error.message.includes(value), false);
      return true;
    });
  }
  assert.equal(validateMemory('# Safe project memory\nNo credentials are included.'), true);
});

test('memory import snapshots, hashes, backs up and atomically replaces only its bounded section', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-memory-import-'));
  const sourceFile = path.join(directory, 'memory.md');
  const claudeFile = path.join(directory, 'CLAUDE.md');
  const databasePath = path.join(directory, 'control.sqlite');
  const source = '# Stable memory\nThe grade portal uses a separate account boundary.\n';
  const original = [
    '# Owner instructions',
    'Keep this prefix byte-for-byte.',
    '<!-- PI_CONTROL_MEMORY_START -->',
    'old generated memory',
    '<!-- PI_CONTROL_MEMORY_END -->',
    'Keep this suffix byte-for-byte.',
    '',
  ].join('\n');
  await writeFile(sourceFile, source);
  await writeFile(claudeFile, original);
  let canaryCalls = 0;
  try {
    const result = await importMemory({
      sourceFile,
      claudeFile,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
      claudeBin: '/usr/local/bin/claude',
      clock: () => FIXED_TIME,
      runCanary: async (input) => {
        canaryCalls += 1;
        assert.equal(input.claudeBin, '/usr/local/bin/claude');
        assert.equal(input.claudeFile, claudeFile);
        assert.equal(input.expectedHash, createHash('sha256').update(source).digest('hex'));
        assert.match(await readFile(claudeFile, 'utf8'), /The grade portal uses a separate account boundary/);
      },
    });
    assert.equal(canaryCalls, 1);
    assert.equal(result.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(await readFile(result.backupPath, 'utf8'), original);
    const updated = await readFile(claudeFile, 'utf8');
    assert.match(updated, /^# Owner instructions\nKeep this prefix byte-for-byte\./);
    assert.match(updated, /Keep this suffix byte-for-byte\.\n$/);
    assert.equal((updated.match(/PI_CONTROL_MEMORY_START/g) ?? []).length, 1);
    assert.equal((updated.match(/PI_CONTROL_MEMORY_END/g) ?? []).length, 1);
    assert.doesNotMatch(updated, /old generated memory/);
    assert.match(updated, /2026-08-03T12:34:56\.000Z/);
    assert.match(updated, new RegExp(result.sha256));
    const db = openDatabase(databasePath);
    const snapshot = db.prepare('SELECT source_file, sha256, body, created_at FROM memory_snapshots').get();
    db.close();
    assert.deepEqual({ ...snapshot }, {
      source_file: path.resolve(sourceFile),
      sha256: result.sha256,
      body: source,
      created_at: FIXED_TIME.toISOString(),
    });
    assert.deepEqual((await readdir(directory)).filter((name) => name.includes('.tmp-')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed memory canary restores CLAUDE.md and does not publish a snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-memory-canary-'));
  const sourceFile = path.join(directory, 'memory.md');
  const claudeFile = path.join(directory, 'CLAUDE.md');
  const databasePath = path.join(directory, 'control.sqlite');
  const original = '# Existing memory\n';
  await writeFile(sourceFile, '# New safe memory\n');
  await writeFile(claudeFile, original);
  try {
    await assert.rejects(importMemory({
      sourceFile,
      claudeFile,
      databasePath,
      backupDirectory: path.join(directory, 'backups'),
      clock: () => FIXED_TIME,
      runCanary: async () => { throw new Error('canary failed'); },
    }), /canary failed/);
    assert.equal(await readFile(claudeFile, 'utf8'), original);
    const db = openDatabase(databasePath);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM memory_snapshots').get().count, 0);
    db.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('history export preserves raw ordered messages in a private atomic JSON file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pi-history-export-'));
  const databasePath = path.join(directory, 'control.sqlite');
  const outputFile = path.join(directory, 'history.json');
  const db = openDatabase(databasePath);
  const conversation = new ConversationService(db);
  conversation.append({ channel: 'telegram', role: 'user', body: 'first raw message' });
  conversation.append({ channel: 'web', role: 'assistant', body: 'second raw message' });
  db.close();
  try {
    const result = await exportHistory({ databasePath, outputFile, clock: () => FIXED_TIME });
    assert.equal(result.count, 2);
    const exported = JSON.parse(await readFile(outputFile, 'utf8'));
    assert.equal(exported.exportedAt, FIXED_TIME.toISOString());
    assert.deepEqual(exported.messages.map(({ sequence, channel, role, body }) => ({ sequence, channel, role, body })), [
      { sequence: 1, channel: 'telegram', role: 'user', body: 'first raw message' },
      { sequence: 2, channel: 'web', role: 'assistant', body: 'second raw message' },
    ]);
    if (process.platform !== 'win32') assert.equal((await stat(outputFile)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Telegram enable and disable use fixed systemctl argv without a shell', async () => {
  const calls = [];
  const run = async (file, args, options) => calls.push({ file, args, options });
  await setTelegramEnabled(false, { run });
  await setTelegramEnabled(true, { run });
  assert.deepEqual(calls.map(({ file, args }) => ({ file, args })), [
    { file: '/usr/bin/systemctl', args: ['disable', '--now', 'telegram-control.service'] },
    { file: '/usr/bin/systemctl', args: ['enable', '--now', 'telegram-control.service'] },
  ]);
  assert.equal(calls.every(({ options }) => options.shell === false), true);
});
