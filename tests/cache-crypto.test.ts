import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  getCacheKey, isCacheEncryptionEnabled,
  encryptField, decryptField, encryptNullable, decryptNullable,
} from '../src/cache-crypto.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

let original: string | undefined;
beforeEach(() => {
  original = process.env.OFW_CACHE_KEY;
  delete process.env.OFW_CACHE_KEY;
});
afterEach(() => {
  if (original === undefined) delete process.env.OFW_CACHE_KEY;
  else process.env.OFW_CACHE_KEY = original;
});

describe('getCacheKey', () => {
  it('returns null when unset or blank', () => {
    delete process.env.OFW_CACHE_KEY;
    expect(getCacheKey()).toBeNull();
    process.env.OFW_CACHE_KEY = '   ';
    expect(getCacheKey()).toBeNull();
    expect(isCacheEncryptionEnabled()).toBe(false);
  });

  it('decodes a valid 32-byte base64 key and reports encryption enabled', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    const key = getCacheKey();
    expect(key).not.toBeNull();
    expect(key!.length).toBe(32);
    expect(isCacheEncryptionEnabled()).toBe(true);
  });

  it('caches the derived key and recomputes when the env value changes', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    const first = getCacheKey();
    expect(getCacheKey()).toBe(first); // cache hit — same Buffer instance
    process.env.OFW_CACHE_KEY = KEY_B;
    const second = getCacheKey();
    expect(second).not.toBe(first); // recomputed on change
    expect(second!.equals(first!)).toBe(false);
  });

  it('throws on a key that does not decode to exactly 32 bytes', () => {
    process.env.OFW_CACHE_KEY = Buffer.from('too-short').toString('base64');
    expect(() => getCacheKey()).toThrow(/32 bytes/);
  });
});

describe('encryptField / decryptField', () => {
  it('is a no-op round-trip when no key is configured', () => {
    delete process.env.OFW_CACHE_KEY;
    expect(encryptField('hello')).toBe('hello');
    expect(decryptField('hello')).toBe('hello');
  });

  it('encrypts to a gcm1: envelope and round-trips with the key', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    const enc = encryptField('court-visible message body');
    expect(enc.startsWith('gcm1:')).toBe(true);
    expect(enc).not.toContain('court-visible');
    expect(decryptField(enc)).toBe('court-visible message body');
  });

  it('uses a random IV so equal plaintexts encrypt differently', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    expect(encryptField('same')).not.toBe(encryptField('same'));
  });

  it('passes through legacy plaintext (no prefix) on decrypt even with a key set', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    expect(decryptField('legacy plaintext row')).toBe('legacy plaintext row');
  });

  it('throws decrypting an encrypted value when no key is configured', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    const enc = encryptField('secret');
    delete process.env.OFW_CACHE_KEY;
    expect(() => decryptField(enc)).toThrow(/OFW_CACHE_KEY is not set/);
  });

  it('throws decrypting with the wrong key (auth-tag failure)', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    const enc = encryptField('secret');
    process.env.OFW_CACHE_KEY = KEY_B;
    expect(() => decryptField(enc)).toThrow(/wrong or the cache is corrupt/);
  });
});

describe('encryptNullable / decryptNullable', () => {
  it('preserves null and round-trips non-null under a key', () => {
    process.env.OFW_CACHE_KEY = KEY_A;
    expect(encryptNullable(null)).toBeNull();
    expect(decryptNullable(null)).toBeNull();
    const enc = encryptNullable('body');
    expect(enc).not.toBeNull();
    expect(decryptNullable(enc)).toBe('body');
  });
});
