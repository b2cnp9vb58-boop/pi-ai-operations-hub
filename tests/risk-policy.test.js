import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalHash } from '../src/shared/canonical-json.js';
import { classifyToolCall } from '../src/security/risk-policy.js';

test('canonical hashing ignores recursive object key order but preserves values', () => {
  const first = canonicalHash({ toolName: 'Read', toolInput: { z: 1, nested: { b: 2, a: 3 } } });
  const second = canonicalHash({ toolInput: { nested: { a: 3, b: 2 }, z: 1 }, toolName: 'Read' });
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, canonicalHash({ toolName: 'Read', toolInput: { z: 2, nested: { b: 2, a: 3 } } }));
});

const highRiskCases = [
  ['Bash', { command: 'rm -rf /var/www/site' }],
  ['Bash', { command: 'sudo systemctl restart nginx' }],
  ['Bash', { command: 'sudo nft flush ruleset' }],
  ['Bash', { command: 'env' }],
  ['Bash', { command: 'cat /etc/pi-control/core.env' }],
  ['Bash', { command: 'echo x > /tmp/value' }],
  ['Bash', { command: 'chmod 600 /tmp/value' }],
  ['Bash', { command: 'apt install nginx' }],
  ['Bash', { command: 'kill -9 123' }],
  ['Bash', { command: 'mount /dev/sda1 /mnt' }],
  ['Bash', { command: 'sqlite3 data.db "delete from users"' }],
  ['Write', { file_path: '/etc/nginx/nginx.conf', content: 'x' }],
  ['Edit', { file_path: '/etc/ssh/sshd_config', old_string: 'a', new_string: 'b' }],
  ['Read', { file_path: '/etc/pi-control/core.env' }],
  ['Read', { file_path: '/home/pi-control/.claude/settings.json' }],
];

for (const [tool, input] of highRiskCases) {
  test(`${tool} ${JSON.stringify(input)} is high risk`, () => {
    const result = classifyToolCall(tool, input);
    assert.equal(result.level, 'high');
    assert.ok(result.reasons.length > 0);
    assert.match(result.operationHash, /^[a-f0-9]{64}$/);
  });
}

const lowRiskCases = [
  ['Read', { file_path: '/var/log/nginx/access.log' }],
  ['Glob', { pattern: '**/*.js', path: '/var/www/site' }],
  ['Grep', { pattern: 'ERROR', path: '/var/log/nginx' }],
  ['Bash', { command: 'systemctl status nginx' }],
  ['Bash', { command: 'journalctl -u nginx -n 20' }],
  ['Bash', { command: 'df -h' }],
  ['Bash', { command: 'free -m' }],
  ['Bash', { command: 'vcgencmd measure_temp' }],
  ['Bash', { command: 'ss -lnt' }],
  ['Bash', { command: 'curl --head https://example.org' }],
  ['Bash', { command: 'nginx -t' }],
];

for (const [tool, input] of lowRiskCases) {
  test(`${tool} ${JSON.stringify(input)} is low risk`, () => {
    assert.equal(classifyToolCall(tool, input).level, 'low');
  });
}

test('ambiguous, compound, malformed and unknown calls fail closed as unknown', () => {
  const calls = [
    ['Bash', { command: 'df -h && rm -rf /tmp/x' }],
    ['Bash', { command: 'df -h; free -m' }],
    ['Bash', { command: 'some-new-command --flag' }],
    ['Bash', {}],
    ['FutureTool', { value: 1 }],
  ];
  for (const [tool, input] of calls) {
    assert.equal(classifyToolCall(tool, input).level, 'unknown');
  }
});

test('read-like tools do not become low risk when a secret or control path is touched', () => {
  for (const path of ['/boot/config.txt', '/opt/pi-control/audit/events.json', '/root/.ssh/id_ed25519']) {
    assert.equal(classifyToolCall('Read', { file_path: path }).level, 'high');
  }
});

test('search tools cannot hide protected or broad paths in alternate fields', () => {
  const high = [
    ['Glob', { path: '/var/www/site', pattern: '/etc/**' }],
    ['Glob', { path: '/var/www/site', pattern: '*.js', glob: '/opt/pi-control/**' }],
    ['Grep', { path: '/var/log/nginx', pattern: '/etc/pi-control/core.env' }],
    ['Grep', { path: '/var/www/site/../../../etc', pattern: 'password' }],
  ];
  for (const [tool, input] of high) assert.equal(classifyToolCall(tool, input).level, 'high');

  const broad = [
    ['Glob', { path: '/', pattern: '**/*' }],
    ['Glob', { path: '/opt/pi-ai-operations-hub/workspace', pattern: '**/*' }],
    ['Grep', { path: '/', pattern: 'ERROR' }],
    ['Glob', { pattern: '**/*.js' }],
  ];
  for (const [tool, input] of broad) assert.equal(classifyToolCall(tool, input).level, 'unknown');
});

test('journalctl mutations are never classified as low risk', () => {
  for (const command of [
    'journalctl --rotate',
    'journalctl --flush',
    'journalctl --sync',
    'journalctl --vacuum-time=2d',
    'journalctl --vacuum-size 100M',
  ]) {
    assert.notEqual(classifyToolCall('Bash', { command }).level, 'low');
  }
  assert.equal(classifyToolCall('Bash', { command: 'journalctl -u nginx -n 20 --no-pager' }).level, 'low');
});

test('absolute and escaping alternate glob fields cannot borrow a safe base', () => {
  const unsafe = [
    ['Glob', { path: '/var/www/site', pattern: '/root/**' }],
    ['Glob', { path: '/var/www/site', pattern: '/var/lib/**' }],
    ['Glob', { path: '/var/www/site', pattern: '../private/**' }],
    ['Glob', { path: '/var/www/site', pattern: '..\\private\\**' }],
    ['Glob', { path: '/var/www/site', pattern: '**/*.js', glob: '/root/**' }],
    ['Grep', { path: '/var/log/nginx', pattern: 'ERROR', glob: '..\\..\\lib\\**' }],
    ['Grep', { path: '/var/log/nginx', pattern: 'ERROR', glob: 'C:\\Windows\\**' }],
  ];
  for (const [tool, input] of unsafe) {
    assert.notEqual(classifyToolCall(tool, input).level, 'low', JSON.stringify(input));
  }

  assert.equal(classifyToolCall('Glob', {
    path: '/var/www/site',
    pattern: 'assets/**/*.js',
    glob: '/var/www/site/public/**',
  }).level, 'low');
});
