function required(env, name, min = 1) {
  const value = String(env[name] ?? '');
  if (value.length < min) {
    throw new Error(`${name} is required and must contain at least ${min} characters`);
  }
  return value;
}

function integerInRange(env, name, defaultValue, min, max, label) {
  const value = Number(env[name] ?? defaultValue);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function resolveCoreConfig(env = process.env) {
  const host = env.PI_CONTROL_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error('core host must be 127.0.0.1');
  }

  const clientKeys = Object.freeze({
    telegram: required(env, 'PI_CONTROL_TELEGRAM_KEY', 32),
    web: required(env, 'PI_CONTROL_WEB_KEY', 32),
    admin: required(env, 'PI_CONTROL_ADMIN_KEY', 32),
    hook: required(env, 'PI_CONTROL_HOOK_KEY', 32),
    weixin: required(env, 'PI_CONTROL_WEIXIN_KEY', 32),
  });
  if (new Set(Object.values(clientKeys)).size !== 5) {
    throw new Error('client keys must be distinct');
  }

  return Object.freeze({
    host,
    port: integerInRange(env, 'PI_CONTROL_PORT', 4330, 4330, 4330, 'core port'),
    dataDir: env.PI_CONTROL_DATA_DIR ?? '/var/lib/pi-control',
    claudeBin: env.PI_CONTROL_CLAUDE_BIN ?? '/usr/local/bin/claude',
    claudeCwd: env.PI_CONTROL_CLAUDE_CWD ?? '/opt/pi-ai-operations-hub/workspace',
    clientKeys,
    approvalTtlMs: integerInRange(env, 'PI_CONTROL_APPROVAL_TTL_MS', 120000, 30000, 300000, 'approval TTL'),
  });
}

export function resolveTelegramConfig(env = process.env) {
  const coreUrl = env.PI_CONTROL_CORE_URL ?? 'http://127.0.0.1:4330';
  if (coreUrl !== 'http://127.0.0.1:4330') {
    throw new Error('core URL must be http://127.0.0.1:4330');
  }
  return Object.freeze({
    botToken: required(env, 'TELEGRAM_BOT_TOKEN', 20),
    coreUrl,
    coreClientKey: required(env, 'PI_CONTROL_TELEGRAM_KEY', 32),
    pollTimeoutSeconds: integerInRange(env, 'TELEGRAM_POLL_TIMEOUT_SECONDS', 45, 1, 50, 'poll timeout'),
  });
}

export function resolveWeixinConfig(env = process.env) {
  const coreUrl = env.PI_CONTROL_CORE_URL ?? 'http://127.0.0.1:4330';
  if (coreUrl !== 'http://127.0.0.1:4330') {
    throw new Error('core URL must be http://127.0.0.1:4330');
  }
  return Object.freeze({
    botToken: env.WEIXIN_BOT_TOKEN ?? '',
    coreUrl,
    coreClientKey: required(env, 'PI_CONTROL_WEIXIN_KEY', 32),
    pollTimeoutSeconds: integerInRange(env, 'WEIXIN_POLL_TIMEOUT_SECONDS', 35, 1, 50, 'weixin poll timeout'),
    coreRequestTimeoutMs: integerInRange(env, 'PI_CONTROL_CORE_REQUEST_TIMEOUT_MS', 10000, 1000, 30000, 'core request timeout'),
  });
}
