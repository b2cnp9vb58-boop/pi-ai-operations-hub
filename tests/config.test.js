import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCoreConfig, resolveTelegramConfig } from '../src/shared/config.js';

function validCoreEnv(overrides = {}) {
  return {
    PI_CONTROL_TELEGRAM_KEY: 't'.repeat(32),
    PI_CONTROL_WEB_KEY: 'w'.repeat(32),
    PI_CONTROL_ADMIN_KEY: 'a'.repeat(32),
    PI_CONTROL_HOOK_KEY: 'h'.repeat(32),
    PI_CONTROL_WEIXIN_KEY: 'x'.repeat(32),
    ...overrides,
  };
}

function validTelegramEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'x'.repeat(20),
    PI_CONTROL_TELEGRAM_KEY: 't'.repeat(32),
    ...overrides,
  };
}

test('core rejects a non-loopback bind address', () => {
  assert.throws(() => resolveCoreConfig({ PI_CONTROL_HOST: '0.0.0.0' }), /127\.0\.0\.1/);
});

test('core accepts only the fixed loopback endpoint', () => {
  for (const host of ['localhost', '::1', '0.0.0.0']) {
    assert.throws(() => resolveCoreConfig(validCoreEnv({ PI_CONTROL_HOST: host })), /127\.0\.0\.1/);
  }
  for (const port of ['4331', 'NaN', '-1', '4330.5']) {
    assert.throws(() => resolveCoreConfig(validCoreEnv({ PI_CONTROL_PORT: port })), /4330/);
  }

  const config = resolveCoreConfig(validCoreEnv());
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4330);
});

test('core requires four distinct client keys', () => {
  const env = {
    PI_CONTROL_TELEGRAM_KEY: 'x'.repeat(32),
    PI_CONTROL_WEB_KEY: 'x'.repeat(32),
    PI_CONTROL_ADMIN_KEY: 'a'.repeat(32),
    PI_CONTROL_HOOK_KEY: 'h'.repeat(32),
    PI_CONTROL_WEIXIN_KEY: 'z'.repeat(32),
  };

  assert.throws(() => resolveCoreConfig(env), /distinct/);
});

test('telegram requires a token and core key', () => {
  assert.throws(() => resolveTelegramConfig({}), /TELEGRAM_BOT_TOKEN/);
});

test('core rejects invalid approval TTL values outside 30 to 300 seconds', () => {
  for (const approvalTtlMs of ['NaN', '-1', '30000.5', '29999', '300001']) {
    assert.throws(() => resolveCoreConfig(validCoreEnv({ PI_CONTROL_APPROVAL_TTL_MS: approvalTtlMs })), /approval TTL/);
  }
});

test('telegram rejects invalid poll timeout values outside 1 to 50 seconds', () => {
  for (const pollTimeoutSeconds of ['NaN', '-1', '1.5', '0', '51']) {
    assert.throws(() => resolveTelegramConfig(validTelegramEnv({ TELEGRAM_POLL_TIMEOUT_SECONDS: pollTimeoutSeconds })), /poll timeout/);
  }
});

test('telegram rejects a core URL other than the fixed loopback endpoint', () => {
  for (const coreUrl of ['http://localhost:4330', 'http://[::1]:4330', 'http://127.0.0.1:4331']) {
    assert.throws(() => resolveTelegramConfig(validTelegramEnv({ PI_CONTROL_CORE_URL: coreUrl })), /127\.0\.0\.1:4330/);
  }
});
