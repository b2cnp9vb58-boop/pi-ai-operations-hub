import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { AttachmentService } from '../src/core/attachment-service.js';
import { routeUpdate } from '../src/telegram/update-router.js';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

test('stored attachments sanitize names, hash content and deduplicate in owner isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-attachments-'));
  try {
    const service = new AttachmentService({ rootDir: root });
    const metadata = { ownerId: '123', originalName: '../../x.log', mimeType: 'text/plain', sizeBytes: 3 };
    const first = await service.store(Readable.from('abc'), metadata);
    const duplicate = await service.store(Readable.from('abc'), metadata);
    assert.equal(first.originalName, 'x.log');
    assert.equal(first.sha256, sha256('abc'));
    assert.equal(first.storedName.includes('..'), false);
    assert.equal(first.storedName, duplicate.storedName);
    assert.equal(readdirSync(join(root, first.ownerStorageKey)).filter((name) => !name.endsWith('.part')).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('attachment limits, MIME-extension mismatch and non-Telegram source URLs fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-attachments-'));
  try {
    const service = new AttachmentService({ rootDir: root, maxFileBytes: 3, maxOwnerBytes: 4 });
    await assert.rejects(service.store(Readable.from('abcd'), {
      ownerId: '123', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 4,
    }), /size/i);
    await assert.rejects(service.store(Readable.from('abc'), {
      ownerId: '123', originalName: 'a.exe', mimeType: 'text/plain', sizeBytes: 3,
    }), /extension|type/i);
    await assert.rejects(service.store(Readable.from('abc'), {
      ownerId: '123', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, sourceUrl: 'http://127.0.0.1/private',
    }), /source/i);
    await service.store(Readable.from('abc'), { ownerId: '123', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 3 });
    await assert.rejects(service.store(Readable.from('de'), { ownerId: '123', originalName: 'b.txt', mimeType: 'text/plain', sizeBytes: 2 }), /quota/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Telegram attachment metadata rejects unsafe ids, oversize and MIME-extension mismatch before core submission', async () => {
  const submissions = [];
  const context = {
    owner: { userId: '123', chatId: '456' },
    submit: async (envelope) => { submissions.push(envelope); return { ok: true }; },
  };
  const message = (document, updateId) => ({ update_id: updateId, message: {
    from: { id: 123 }, chat: { id: 456, type: 'private' }, document,
  } });
  await routeUpdate(message({ file_id: 'http://127.0.0.1/x', file_name: 'a.txt', mime_type: 'text/plain', file_size: 3 }, 1), context);
  await routeUpdate(message({ file_id: 'safe-id', file_name: 'a.txt', mime_type: 'text/plain', file_size: 20 * 1024 * 1024 + 1 }, 2), context);
  await routeUpdate(message({ file_id: 'safe-id', file_name: 'a.exe', mime_type: 'text/plain', file_size: 3 }, 3), context);
  await routeUpdate(message({ file_id: 'safe-id_4', file_name: '../../a.txt', mime_type: 'text/plain', file_size: 3 }, 4), context);
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].attachments, [{
    kind: 'document', fileId: 'safe-id_4', fileName: '../../a.txt', mimeType: 'text/plain', sizeBytes: 3,
  }]);
});

test('concurrent same-owner commits deduplicate and cannot race past quota', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-attachments-race-'));
  try {
    const service = new AttachmentService({ rootDir: root, maxFileBytes: 5, maxOwnerBytes: 5 });
    const meta = { ownerId: 'same', originalName: 'a.txt', mimeType: 'text/plain', sizeBytes: 3 };
    const duplicates = await Promise.all(Array.from({ length: 8 }, () => service.store(Readable.from('abc'), meta)));
    assert.equal(new Set(duplicates.map((item) => item.storedName)).size, 1);
    const raced = await Promise.allSettled([
      service.store(Readable.from('de'), { ...meta, originalName: 'b.txt', sizeBytes: 2 }),
      service.store(Readable.from('fg'), { ...meta, originalName: 'c.txt', sizeBytes: 2 }),
    ]);
    assert.equal(raced.filter((item) => item.status === 'fulfilled').length, 1);
    const ownerDir = join(root, duplicates[0].ownerStorageKey);
    const names = readdirSync(ownerDir);
    assert.equal(names.filter((name) => name.endsWith('.part')).length, 0);
    assert.equal(names.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
