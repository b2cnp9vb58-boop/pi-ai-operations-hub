import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicFiles = [
  'systemd/pi-control-core.service',
  'systemd/telegram-control.service',
  'systemd/weixin-control.service',
  'config/claude-settings.json',
];

test('public deployment templates do not identify the private production environment', () => {
  for (const relativePath of publicFiles) {
    const filePath = path.join(repositoryRoot, relativePath);
    assert.equal(existsSync(filePath), true, `${relativePath} must exist`);
    const content = readFileSync(filePath, 'utf8');
    assert.doesNotMatch(content, /yespipi|rankline|grade-v2|grade-ai|awuka1/i, relativePath);
  }
});
