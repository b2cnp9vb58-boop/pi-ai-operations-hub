import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

test('systemd templates keep the core local and gateways unprivileged', () => {
  const core = read('systemd/pi-control-core.service');
  const telegram = read('systemd/telegram-control.service');
  const weixin = read('systemd/weixin-control.service');

  assert.match(core, /^WorkingDirectory=\/opt\/pi-ai-operations-hub\/current$/m);
  assert.match(core, /^EnvironmentFile=\/etc\/pi-ai-operations-hub\/core\.env$/m);
  assert.match(core, /^ProtectSystem=strict$/m);
  assert.match(core, /^Before=nginx\.service cloudflared\.service$/m);

  for (const gateway of [telegram, weixin]) {
    assert.match(gateway, /^NoNewPrivileges=true$/m);
    assert.match(gateway, /^CapabilityBoundingSet=$/m);
    assert.doesNotMatch(gateway, /User=root|sudo/);
    assert.match(gateway, /^Requires=pi-control-core\.service$/m);
  }
});

test('deployment guide keeps credentials outside the checkout and preserves the WeChat read-only boundary', () => {
  const guide = read('docs/DEPLOYMENT.md');
  assert.match(guide, /three root-owned files instead/);
  assert.match(guide, /\/etc\/pi-ai-operations-hub\/core\.env/);
  assert.match(guide, /bound only to `127\.0\.0\.1`/i);
  assert.match(guide, /WeChat cannot create, cancel, approve, or mutate a task/);
  assert.doesNotMatch(guide, /yespipi|rankline|grade-v2|grade-ai|awuka1/i);
});
