import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const RECORD_PREFIX = 'scrypt$v=1$N=16384,r=8,p=1$';
const RECORD_PATTERN = /^scrypt\$v=1\$N=16384,r=8,p=1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

async function derive(password, salt) {
  return scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS);
}

function parseRecord(record) {
  if (typeof record !== 'string') return null;
  const match = RECORD_PATTERN.exec(record);
  if (!match) return null;
  const salt = Buffer.from(match[1], 'base64url');
  const digest = Buffer.from(match[2], 'base64url');
  if (salt.length !== SALT_BYTES || digest.length !== KEY_BYTES) return null;
  if (salt.toString('base64url') !== match[1] || digest.toString('base64url') !== match[2]) return null;
  return { salt, digest };
}

export async function hashConfirmationPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('confirmation password must not be empty');
  }
  const salt = randomBytes(SALT_BYTES);
  const digest = await derive(password, salt);
  try {
    return `${RECORD_PREFIX}${salt.toString('base64url')}$${digest.toString('base64url')}`;
  } finally {
    digest.fill(0);
  }
}

export async function verifyConfirmationPassword(password, record) {
  const parsed = parseRecord(record);
  const validPassword = typeof password === 'string';
  const salt = parsed?.salt ?? Buffer.alloc(SALT_BYTES);
  const expected = parsed?.digest ?? Buffer.alloc(KEY_BYTES);
  const actual = await derive(validPassword ? password : '', salt);
  try {
    const matches = timingSafeEqual(actual, expected);
    return Boolean(parsed && validPassword && matches);
  } finally {
    actual.fill(0);
  }
}
