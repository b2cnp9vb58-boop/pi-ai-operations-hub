import { TextDecoder } from 'node:util';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody(request, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw new HttpError(413, 'body_too_large', `JSON body must not exceed ${maxBytes} bytes`);
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      request.resume();
      throw new HttpError(413, 'body_too_large', `JSON body must not exceed ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }

  if (size === 0) {
    throw new HttpError(400, 'invalid_json', 'JSON body is required');
  }

  let value;
  try {
    value = JSON.parse(UTF8_DECODER.decode(Buffer.concat(chunks, size)));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Malformed JSON body');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_json', 'JSON body must be an object');
  }
  return value;
}

export function requireExactFields(value, { allowed, required = allowed }) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new HttpError(400, 'unknown_field', `Unknown field: ${unknown}`);
  }
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing !== undefined) {
    throw new HttpError(400, 'missing_field', `Missing field: ${missing}`);
  }
  return value;
}

export function writeJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

export function writeError(response, error) {
  if (error instanceof HttpError) {
    writeJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(response, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
}
