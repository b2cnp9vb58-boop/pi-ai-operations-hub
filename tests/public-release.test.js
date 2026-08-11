import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('public release includes bilingual documentation and a secret-free environment template', () => {
  const requiredFiles = [
    'README.md',
    'README.zh-CN.md',
    'SECURITY.md',
    '.env.example',
    'docs/ARCHITECTURE.md',
    'docs/ARCHITECTURE.zh-CN.md',
    'docs/DEPLOYMENT.md',
    'docs/DEPLOYMENT.zh-CN.md',
  ];

  for (const relativePath of requiredFiles) {
    assert.equal(existsSync(path.join(repositoryRoot, relativePath)), true, `${relativePath} must exist`);
  }

  const environmentTemplate = readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');
  assert.match(environmentTemplate, /^TELEGRAM_BOT_TOKEN=<replace-with-your-token>$/m);
  assert.match(environmentTemplate, /^PI_CONTROL_TELEGRAM_KEY=<generate-at-install-time>$/m);
  assert.doesNotMatch(environmentTemplate, /sk-[A-Za-z0-9_-]{12,}/);
  assert.doesNotMatch(environmentTemplate, /\d{8,}:[A-Za-z0-9_-]{20,}/);
});
