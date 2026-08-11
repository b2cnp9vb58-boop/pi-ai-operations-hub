import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveBash } from './helpers/bash.js';

const root = path.resolve(import.meta.dirname, '..');
const bash = resolveBash();
const posix = (value) => value.replace(/^([A-Za-z]):\\/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll('\\', '/');

test('captured unit enabled and active states are restored exactly', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-systemd-state-'));
  const fake = path.join(directory, 'systemctl');
  const state = path.join(directory, 'state');
  const log = path.join(directory, 'log');
  const snapshot = path.join(directory, 'snapshot.tsv');
  writeFileSync(state, 'core.service enabled active\ngateway.service disabled inactive\n');
  writeFileSync(fake, `#!/usr/bin/env bash
set -euo pipefail
command=$1; shift
unit=\${1:-}
case "$command" in
  is-enabled) grep -q "^$unit enabled " "$FAKE_STATE" ;;
  is-active) grep -q "^$unit [^ ]* active$" "$FAKE_STATE" ;;
  enable|disable|start|stop) printf '%s %s\\n' "$command" "$unit" >>"$FAKE_LOG" ;;
  *) exit 2 ;;
esac
`);
  chmodSync(fake, 0o755);
  try {
    execFileSync(bash, ['-c', `source deploy/systemd-state.sh; capture_unit_states "$SNAPSHOT" core.service gateway.service; restore_unit_states "$SNAPSHOT"`], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${posix(directory)}:${process.env.PATH}`,
        FAKE_STATE: posix(state),
        FAKE_LOG: posix(log),
        SNAPSHOT: posix(snapshot),
      },
    });
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').sort(), [
      'disable gateway.service', 'enable core.service', 'start core.service', 'stop gateway.service',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
