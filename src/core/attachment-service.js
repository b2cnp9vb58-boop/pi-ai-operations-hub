import { createHash, randomUUID } from 'node:crypto';
import { basename, extname, join, resolve, sep } from 'node:path';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';

const DEFAULT_FILE_LIMIT = 20 * 1024 * 1024;
const DEFAULT_OWNER_LIMIT = 2 * 1024 * 1024 * 1024;
const MIME_EXTENSIONS = new Map([
  ['image/jpeg', new Set(['.jpg', '.jpeg'])],
  ['image/png', new Set(['.png'])],
  ['image/webp', new Set(['.webp'])],
  ['application/pdf', new Set(['.pdf'])],
  ['text/plain', new Set(['.txt', '.log'])],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', new Set(['.docx'])],
]);

function safeName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 255 || value.includes('\0')) throw new TypeError('invalid original name');
  const result = basename(value.replaceAll('\\', '/'));
  if (!result || result === '.' || result === '..') throw new TypeError('invalid original name');
  return result;
}

function validateSource(sourceUrl) {
  if (sourceUrl === undefined) return;
  let url;
  try { url = new URL(sourceUrl); } catch { throw new TypeError('invalid attachment source'); }
  if (url.protocol !== 'https:' || url.hostname !== 'api.telegram.org' || url.port || url.username || url.password
    || !url.pathname.startsWith('/file/')) throw new TypeError('attachment source is not permitted');
}

async function usage(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.endsWith('.part')) continue;
    total += (await stat(join(directory, entry.name))).size;
  }
  return total;
}

export class AttachmentService {
  constructor({ rootDir, maxFileBytes = DEFAULT_FILE_LIMIT, maxOwnerBytes = DEFAULT_OWNER_LIMIT } = {}) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) throw new TypeError('rootDir is required');
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) throw new TypeError('invalid file size limit');
    if (!Number.isSafeInteger(maxOwnerBytes) || maxOwnerBytes < maxFileBytes) throw new TypeError('invalid owner quota');
    this.rootDir = resolve(rootDir);
    this.maxFileBytes = maxFileBytes;
    this.maxOwnerBytes = maxOwnerBytes;
    this.ownerLocks = new Map();
  }

  async #withOwnerLock(ownerStorageKey, work) {
    const previous = this.ownerLocks.get(ownerStorageKey) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    this.ownerLocks.set(ownerStorageKey, current);
    try {
      return await current;
    } finally {
      if (this.ownerLocks.get(ownerStorageKey) === current) this.ownerLocks.delete(ownerStorageKey);
    }
  }

  async store(stream, metadata = {}) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new TypeError('attachment stream is required');
    if (typeof metadata.ownerId !== 'string' || metadata.ownerId.length === 0) throw new TypeError('ownerId is required');
    const originalName = safeName(metadata.originalName);
    const extensions = MIME_EXTENSIONS.get(metadata.mimeType);
    const extension = extname(originalName).toLowerCase();
    if (!extensions || !extensions.has(extension)) throw new TypeError('attachment MIME type and extension are not permitted');
    if (metadata.sizeBytes !== undefined && (!Number.isSafeInteger(metadata.sizeBytes) || metadata.sizeBytes < 0 || metadata.sizeBytes > this.maxFileBytes)) {
      throw new RangeError('attachment declared size exceeds limit');
    }
    validateSource(metadata.sourceUrl);

    const ownerStorageKey = createHash('sha256').update(metadata.ownerId).digest('hex').slice(0, 32);
    const ownerDir = resolve(this.rootDir, ownerStorageKey);
    if (!ownerDir.startsWith(`${this.rootDir}${sep}`)) throw new Error('owner storage path escaped root');
    await mkdir(ownerDir, { recursive: true, mode: 0o700 });
    const temporary = join(ownerDir, `${randomUUID()}.part`);
    const handle = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    let sizeBytes = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        sizeBytes += chunk.length;
        if (sizeBytes > this.maxFileBytes) throw new RangeError('attachment size exceeds limit');
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    if (metadata.sizeBytes !== undefined && metadata.sizeBytes !== sizeBytes) {
      await rm(temporary, { force: true });
      throw new RangeError('attachment size did not match metadata');
    }

    const sha256 = hash.digest('hex');
    try {
      return await this.#withOwnerLock(ownerStorageKey, async () => {
        const duplicate = (await readdir(ownerDir)).find((name) => name.startsWith(`${sha256}-`) && !name.endsWith('.part'));
        if (duplicate) {
          await rm(temporary, { force: true });
          return { originalName, storedName: duplicate, ownerStorageKey, mimeType: metadata.mimeType, sizeBytes, sha256 };
        }
        if (await usage(ownerDir) + sizeBytes > this.maxOwnerBytes) throw new RangeError('owner attachment quota exceeded');
        const storedName = `${sha256}-${randomUUID()}${extension}`;
        await rename(temporary, join(ownerDir, storedName));
        return { originalName, storedName, ownerStorageKey, mimeType: metadata.mimeType, sizeBytes, sha256 };
      });
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}
