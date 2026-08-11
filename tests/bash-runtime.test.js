import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBash } from './helpers/bash.js';

test('an explicit BASH environment override always wins', () => {
  assert.equal(resolveBash({ env: { BASH: '/custom/bash' }, platform: 'win32' }), '/custom/bash');
});

test('Windows selects Git Bash and Linux selects its native Bash', () => {
  assert.equal(resolveBash({ env: {}, platform: 'win32' }), 'C:/Program Files/Git/bin/bash.exe');
  assert.equal(resolveBash({ env: {}, platform: 'linux', exists: () => true }), '/bin/bash');
  assert.equal(resolveBash({ env: {}, platform: 'linux', exists: () => false }), 'bash');
});
