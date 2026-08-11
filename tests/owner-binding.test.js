import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const verifier = path.join(root, 'deploy', 'verify-owner.py');

function database(rows) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pi-owner-db-'));
  const filename = path.join(directory, 'control.sqlite');
  const script = [
    'import sqlite3,sys',
    'db=sqlite3.connect(sys.argv[1])',
    "db.execute('create table owner_binding(singleton integer, user_id text, chat_id text)')",
    `db.executemany('insert into owner_binding values(1,?,?)', ${JSON.stringify(rows)})`,
    'db.commit()',
  ].join(';');
  execFileSync('python', ['-c', script, filename]);
  return { directory, filename };
}

test('owner verifier requires exactly one matching persisted user and private-chat id', () => {
  const one = database([['12345', '67890']]);
  const duplicate = database([['12345', '67890'], ['12345', '67890']]);
  try {
    execFileSync('python', [verifier, one.filename, '12345', '67890']);
    assert.notEqual(spawnSync('python', [verifier, one.filename, '99999', '67890']).status, 0);
    assert.notEqual(spawnSync('python', [verifier, duplicate.filename, '12345', '67890']).status, 0);
  } finally {
    rmSync(one.directory, { recursive: true, force: true });
    rmSync(duplicate.directory, { recursive: true, force: true });
  }
});
