#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { promisify } from 'node:util';
import { openDatabase } from '../src/db/database.js';
import { approvePairing } from '../src/security/identity.js';
import { hashConfirmationPassword } from '../src/security/password.js';
import { isMainModule } from '../src/shared/main-module.js';

const DEFAULT_DATA_DIR = '/var/lib/pi-control/shared';
const DEFAULT_PASSWORD_FILE = '/etc/pi-control/high-risk-password.hash';
const DEFAULT_CLAUDE_FILE = '/opt/pi-ai-operations-hub/workspace/CLAUDE.md';
const DEFAULT_CLAUDE_BIN = '/usr/local/bin/claude';
const MEMORY_START = '<!-- PI_CONTROL_MEMORY_START -->';
const MEMORY_END = '<!-- PI_CONTROL_MEMORY_END -->';
const execFileAsync = promisify(execFile);
const SECRET_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|cookie|session(?:id|[_ -]?(?:token|key|secret)))\s*[:=]\s*["']?\S+/i,
  /\b(?:Cookie|Set-Cookie)\s*:\s*\S+/i,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/,
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
]);

function dateFrom(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must return a valid date');
  return date;
}

async function atomicWrite(filename, body, mode = 0o600) {
  if (typeof body !== 'string') throw new TypeError('atomic body must be a string');
  const directory = dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(filename)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(body, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await rename(temporary, filename);
    await chmod(filename, mode);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function validateMemory(body) {
  if (typeof body !== 'string' || body.trim().length === 0) throw new TypeError('memory must be non-empty text');
  if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) throw new Error('memory exceeds the 2 MiB limit');
  if (body.includes(MEMORY_START) || body.includes(MEMORY_END) || SECRET_PATTERNS.some((pattern) => pattern.test(body))) {
    throw new Error('memory contains secret-shaped content');
  }
  return true;
}

function generatedMemorySection({ body, sourceFile, sha256, importedAt }) {
  return [
    MEMORY_START,
    '## Pi control synchronized memory',
    '',
    `Imported: ${importedAt}`,
    `Source: ${basename(sourceFile)}`,
    `SHA-256: ${sha256}`,
    '',
    body.trimEnd(),
    MEMORY_END,
  ].join('\n');
}

function replaceMemorySection(existing, section) {
  const start = existing.indexOf(MEMORY_START);
  const end = existing.indexOf(MEMORY_END);
  const duplicateStart = start >= 0 && existing.indexOf(MEMORY_START, start + MEMORY_START.length) >= 0;
  const duplicateEnd = end >= 0 && existing.indexOf(MEMORY_END, end + MEMORY_END.length) >= 0;
  if ((start >= 0) !== (end >= 0) || duplicateStart || duplicateEnd || (start >= 0 && end < start)) {
    throw new Error('CLAUDE.md contains a malformed managed memory section');
  }
  if (start >= 0) return `${existing.slice(0, start)}${section}${existing.slice(end + MEMORY_END.length)}`;
  if (existing.length === 0) return `${section}\n`;
  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${section}\n`;
}

async function defaultMemoryCanary({ claudeBin, claudeFile, expectedHash }) {
  const prompt = [
    'This is a read-only memory import canary.',
    'Read the Pi control synchronized memory section already loaded from CLAUDE.md.',
    `If its SHA-256 metadata is exactly ${expectedHash}, reply exactly MEMORY_SYNC_OK.`,
    'Do not use tools and do not output any memory content.',
  ].join(' ');
  const { stdout } = await execFileAsync(claudeBin, ['--print', prompt], {
    cwd: dirname(claudeFile),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (String(stdout).trim() !== 'MEMORY_SYNC_OK') throw new Error('Claude memory canary failed');
}

export async function importMemory({
  sourceFile,
  claudeFile = DEFAULT_CLAUDE_FILE,
  databasePath = join(DEFAULT_DATA_DIR, 'conversations.sqlite'),
  backupDirectory = join(DEFAULT_DATA_DIR, 'memory-backups'),
  claudeBin = DEFAULT_CLAUDE_BIN,
  clock = () => new Date(),
  runCanary = defaultMemoryCanary,
} = {}) {
  if (typeof sourceFile !== 'string' || !sourceFile) throw new TypeError('memory source file is required');
  if (typeof runCanary !== 'function') throw new TypeError('memory canary function is required');
  const canonicalSource = await realpath(resolve(sourceFile));
  const body = await readFile(canonicalSource, 'utf8');
  validateMemory(body);
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
  const importedAt = dateFrom(clock).toISOString();
  let original = '';
  let originalExists = true;
  let originalMode = 0o600;
  try {
    original = await readFile(claudeFile, 'utf8');
    originalMode = (await stat(claudeFile)).mode & 0o777;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    originalExists = false;
  }
  const section = generatedMemorySection({ body, sourceFile: canonicalSource, sha256, importedAt });
  const updated = replaceMemorySection(original, section);
  const safeStamp = importedAt.replaceAll(/[-:.]/g, '');
  const backupPath = originalExists
    ? join(backupDirectory, `CLAUDE.md.${safeStamp}.${randomBytes(4).toString('hex')}.bak`)
    : null;
  if (backupPath) await atomicWrite(backupPath, original, 0o600);
  await atomicWrite(claudeFile, updated, originalMode);
  try {
    await runCanary({ claudeBin, claudeFile, expectedHash: sha256 });
    const db = openDatabase(databasePath);
    try {
      db.prepare(`
        INSERT INTO memory_snapshots(id, source_file, sha256, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), canonicalSource, sha256, body, importedAt);
    } finally {
      db.close();
    }
  } catch (error) {
    if (originalExists) await atomicWrite(claudeFile, original, originalMode);
    else await rm(claudeFile, { force: true });
    throw error;
  }
  return { sourceFile: canonicalSource, sha256, importedAt, backupPath };
}

export async function exportHistory({
  databasePath = join(DEFAULT_DATA_DIR, 'conversations.sqlite'),
  outputFile,
  clock = () => new Date(),
} = {}) {
  if (typeof outputFile !== 'string' || !outputFile) throw new TypeError('history output file is required');
  const db = openDatabase(databasePath);
  let messages;
  try {
    messages = db.prepare(`
      SELECT id, sequence, channel, role, body, task_id AS taskId, created_at AS createdAt
      FROM messages ORDER BY sequence
    `).all();
  } finally {
    db.close();
  }
  const exportedAt = dateFrom(clock).toISOString();
  await atomicWrite(resolve(outputFile), `${JSON.stringify({ schemaVersion: 1, exportedAt, messages }, null, 2)}\n`, 0o600);
  return { outputFile: resolve(outputFile), exportedAt, count: messages.length };
}

export async function setTelegramEnabled(enabled, { run = execFileAsync } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('Telegram enabled state must be boolean');
  if (typeof run !== 'function') throw new TypeError('service command runner is required');
  const args = enabled
    ? ['enable', '--now', 'telegram-control.service']
    : ['disable', '--now', 'telegram-control.service'];
  await run('/usr/bin/systemctl', args, { shell: false, windowsHide: true, timeout: 30_000 });
  return { enabled };
}

export async function writeConfirmationPasswordFile(filename, password, confirmation) {
  if (password !== confirmation) throw new Error('passwords do not match');
  const record = await hashConfirmationPassword(password);
  const directory = dirname(filename);
  const temporary = join(
    directory,
    `.confirmation-password.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(record, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, filename);
    await chmod(filename, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function readSecretFromTty(prompt, input = process.stdin, output = process.stderr) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('password input requires a TTY'));
  }

  let wasPaused;
  let wasRaw;
  try {
    wasPaused = input.isPaused();
    wasRaw = Boolean(input.isRaw);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const characters = [];
    const decoder = new StringDecoder('utf8');
    let settled = false;
    let cleaned = false;

    function cleanup() {
      if (cleaned) return null;
      cleaned = true;
      let cleanupError;

      for (const [event, listener] of [
        ['data', onData],
        ['error', onError],
        ['end', onEnd],
        ['close', onClose],
      ]) {
        try {
          input.removeListener(event, listener);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        input.setRawMode(wasRaw);
      } catch (error) {
        cleanupError ??= error;
      }
      try {
        if (wasPaused) input.pause();
        else input.resume();
      } catch (error) {
        cleanupError ??= error;
      }
      return cleanupError;
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      let finalError = error;
      try {
        output.write('\n');
      } catch (outputError) {
        finalError ??= outputError;
      } finally {
        const cleanupError = cleanup();
        finalError ??= cleanupError;
      }
      if (finalError) reject(finalError);
      else resolve(value);
    }

    function onData(chunk) {
      let text;
      try {
        text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      } catch (error) {
        finish(error);
        return;
      }
      for (const character of text) {
        if (character === '\u0003' || character === '\u0004') {
          finish(new Error('password entry cancelled'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(undefined, characters.join(''));
          return;
        }
        if (character === '\b' || character === '\u007f') characters.pop();
        else characters.push(character);
      }
    }

    function onError(error) {
      finish(error);
    }

    function onEnd() {
      finish(new Error('password input ended before completion'));
    }

    function onClose() {
      finish(new Error('password input closed before completion'));
    }

    try {
      output.write(prompt);
      input.on('data', onData);
      input.on('error', onError);
      input.on('end', onEnd);
      input.on('close', onClose);
      input.setRawMode(true);
      if (settled) return;
      input.resume();
    } catch (error) {
      finish(error);
    }
  });
}

export async function adminMain(argv, env) {
  const [command, argument, ...extra] = argv;
  const dataDir = env.PI_CONTROL_DATA_DIR ?? DEFAULT_DATA_DIR;
  const databasePath = env.PI_CONTROL_DB_PATH ?? join(dataDir, 'conversations.sqlite');
  const passwordPath = env.PI_CONTROL_PASSWORD_FILE ?? DEFAULT_PASSWORD_FILE;

  if (command === 'pair' && argument && extra.length === 0) {
    const db = openDatabase(databasePath);
    try {
      approvePairing(db, argument);
    } finally {
      db.close();
    }
    process.stdout.write('Owner paired.\n');
    return;
  }

  if (command === 'set-password' && argument === undefined) {
    const password = await readSecretFromTty('Confirmation password: ');
    const confirmation = await readSecretFromTty('Repeat confirmation password: ');
    await writeConfirmationPasswordFile(passwordPath, password, confirmation);
    process.stdout.write('Confirmation password updated.\n');
    return;
  }

  if (command === 'import-memory' && argument && extra.length === 0) {
    const result = await importMemory({
      sourceFile: argument,
      claudeFile: env.PI_CONTROL_CLAUDE_MEMORY_FILE ?? DEFAULT_CLAUDE_FILE,
      databasePath,
      backupDirectory: env.PI_CONTROL_MEMORY_BACKUP_DIR ?? join(dataDir, 'memory-backups'),
      claudeBin: env.PI_CONTROL_CLAUDE_BIN ?? DEFAULT_CLAUDE_BIN,
    });
    process.stdout.write(`Memory imported (SHA-256 ${result.sha256}).\n`);
    return;
  }

  if (command === 'export-history' && argument && extra.length === 0) {
    const result = await exportHistory({ databasePath, outputFile: argument });
    process.stdout.write(`Exported ${result.count} messages.\n`);
    return;
  }

  if (command === 'disable-telegram' && argument === undefined) {
    await setTelegramEnabled(false);
    process.stdout.write('Telegram gateway disabled.\n');
    return;
  }

  if (command === 'enable-telegram' && argument === undefined) {
    await setTelegramEnabled(true);
    process.stdout.write('Telegram gateway enabled.\n');
    return;
  }

  throw new Error('usage: pi-control-admin pair <code> | set-password | import-memory <markdown-file> | export-history <output-file> | disable-telegram | enable-telegram');
}

const isMain = isMainModule(import.meta.url);

if (isMain) {
  adminMain(process.argv.slice(2), process.env).catch((error) => {
    process.stderr.write(`pi-control-admin: ${error.message}\n`);
    process.exitCode = 1;
  });
}
