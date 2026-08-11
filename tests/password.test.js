import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  readSecretFromTty,
  writeConfirmationPasswordFile,
} from '../bin/pi-control-admin.mjs';
import {
  hashConfirmationPassword,
  verifyConfirmationPassword,
} from '../src/security/password.js';

function testPassword() {
  return randomBytes(24).toString('base64url');
}

class FakeTty extends EventEmitter {
  constructor({ raw = false, paused = true, failSetRawMode = false, failResume = false } = {}) {
    super();
    this.isTTY = true;
    this.isRaw = raw;
    this.paused = paused;
    this.failSetRawMode = failSetRawMode;
    this.failResume = failResume;
  }

  isPaused() {
    return this.paused;
  }

  setRawMode(value) {
    if (value && this.failSetRawMode) throw new Error('controlled raw-mode failure');
    this.isRaw = value;
    return this;
  }

  resume() {
    if (this.failResume) throw new Error('controlled resume failure');
    this.paused = false;
    return this;
  }

  pause() {
    this.paused = true;
    return this;
  }
}

function captureOutput() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
      return true;
    },
  };
}

function assertTtyRestored(input, { raw = false, paused = true } = {}) {
  assert.equal(input.isRaw, raw);
  assert.equal(input.isPaused(), paused);
  for (const event of ['data', 'keypress', 'error', 'end', 'close']) {
    assert.equal(input.listenerCount(event), 0, `${event} listener leaked`);
  }
}

test('scrypt records omit plaintext and verify correct and wrong passwords', async () => {
  const password = testPassword();
  const wrongPassword = testPassword();

  const record = await hashConfirmationPassword(password);

  assert.equal(record.includes(password), false);
  assert.equal(await verifyConfirmationPassword(password, record), true);
  assert.equal(await verifyConfirmationPassword(wrongPassword, record), false);
});

test('each password record uses an independent random salt', async () => {
  const password = testPassword();

  const first = await hashConfirmationPassword(password);
  const second = await hashConfirmationPassword(password);

  assert.notEqual(first, second);
  assert.equal(await verifyConfirmationPassword(password, first), true);
  assert.equal(await verifyConfirmationPassword(password, second), true);
});

test('malformed password records fail closed without throwing', async () => {
  const password = testPassword();
  const malformedRecords = [
    null,
    '',
    'not-a-scrypt-record',
    'scrypt$v=1$N=1,r=1,p=1$AA$AA',
    'scrypt$v=1$N=16384,r=8,p=1$not_base64url!$also_bad!',
  ];

  for (const record of malformedRecords) {
    assert.equal(await verifyConfirmationPassword(password, record), false);
  }
});

test('admin password writer stores only a verifiable record with mode 0600', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-control-password-'));
  const filename = join(directory, 'confirmation-password.scrypt');
  const password = testPassword();
  try {
    await writeConfirmationPasswordFile(filename, password, password);

    const record = await readFile(filename, 'utf8');
    const metadata = await stat(filename);
    assert.equal(record.includes(password), false);
    assert.equal(await verifyConfirmationPassword(password, record), true);
    if (process.platform !== 'win32') assert.equal(metadata.mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('admin password writer rejects mismatched confirmation without creating a file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-control-password-'));
  const filename = join(directory, 'confirmation-password.scrypt');
  try {
    await assert.rejects(
      writeConfirmationPasswordFile(filename, testPassword(), testPassword()),
      /do not match/i,
    );
    await assert.rejects(stat(filename), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('TTY setup failures reject and restore all input state and listeners', async (t) => {
  for (const failure of [
    { name: 'raw mode', options: { failSetRawMode: true } },
    { name: 'resume', options: { failResume: true } },
  ]) {
    await t.test(failure.name, async () => {
      const input = new FakeTty(failure.options);
      await assert.rejects(readSecretFromTty('Prompt: ', input, captureOutput()), /controlled/);
      assertTtyRestored(input);
    });
  }
});

test('TTY error, end, close, and Ctrl-C reject without hanging or leaking state', async (t) => {
  const endings = [
    { name: 'error', emit: (input) => input.emit('error', new Error('controlled input failure')) },
    { name: 'end', emit: (input) => input.emit('end') },
    { name: 'close', emit: (input) => input.emit('close') },
    { name: 'Ctrl-C', emit: (input) => input.emit('data', Buffer.from([3])) },
  ];

  for (const ending of endings) {
    await t.test(ending.name, async () => {
      const input = new FakeTty();
      const reading = readSecretFromTty('Prompt: ', input, captureOutput());
      ending.emit(input);
      await assert.rejects(reading);
      assertTtyRestored(input);
    });
  }
});

test('two TTY reads do not echo input and restore the initial raw and pause states', async () => {
  const input = new FakeTty();
  const output = captureOutput();
  const firstSecret = testPassword();
  const secondSecret = testPassword();

  const firstRead = readSecretFromTty('First: ', input, output);
  input.emit('data', Buffer.from(`${firstSecret}\r`, 'utf8'));
  assert.equal(await firstRead, firstSecret);
  assertTtyRestored(input);

  const secondRead = readSecretFromTty('Second: ', input, output);
  input.emit('data', Buffer.from(`${secondSecret}\r`, 'utf8'));
  assert.equal(await secondRead, secondSecret);
  assertTtyRestored(input);
  assert.equal(output.text.includes(firstSecret), false);
  assert.equal(output.text.includes(secondSecret), false);

  const activeRawInput = new FakeTty({ raw: true, paused: false });
  const activeRawSecret = testPassword();
  const activeRawRead = readSecretFromTty('Active: ', activeRawInput, output);
  activeRawInput.emit('data', Buffer.from(`${activeRawSecret}\r`, 'utf8'));
  assert.equal(await activeRawRead, activeRawSecret);
  assertTtyRestored(activeRawInput, { raw: true, paused: false });
  assert.equal(output.text.includes(activeRawSecret), false);
});
