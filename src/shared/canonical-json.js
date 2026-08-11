import { createHash } from 'node:crypto';

function normalize(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON only supports finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('canonical JSON cannot contain cycles');
    seen.add(value);
    try {
      return value.map((entry) => normalize(entry, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('canonical JSON cannot contain cycles');
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError('canonical JSON only supports plain objects');
    }
    seen.add(value);
    try {
      const result = {};
      for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) throw new TypeError('canonical JSON does not support undefined');
        result[key] = normalize(value[key], seen);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalHash(value) {
  return createHash('sha256').update(JSON.stringify(normalize(value, new Set())), 'utf8').digest('hex');
}
