// Optional at-rest encryption for the content-bearing cache columns
// (message/draft subject + body + recipients + list payloads, attachment
// names/metadata). OFW is a court-of-record platform, so the local SQLite
// cache holds a full copy of co-parenting message history; the audit flagged
// that as plaintext-on-disk, exposed to any backup/sync agent that scoops
// ~/.cache. This module encrypts those fields when OFW_CACHE_KEY is set.
//
// Design:
//   - AES-256-GCM, random 12-byte IV per field, 16-byte auth tag. Stored as
//     `gcm1:<base64(iv|tag|ciphertext)>`.
//   - encryptField/decryptField are NO-OPS when no key is configured, so the
//     cache layer can call them unconditionally — behavior only changes once a
//     key exists. Backward compatible with existing plaintext caches.
//   - decryptField passes through any value WITHOUT the `gcm1:` prefix, so a
//     cache that mixes legacy plaintext rows and freshly-encrypted rows (the
//     state right after a user turns encryption on) reads correctly. Rows
//     migrate to ciphertext naturally as sync re-upserts them.
//
// The key must live OUTSIDE the cache dir (e.g. an exported env var from a
// secrets file) — that separation is what defends the "backup scooped the DB"
// threat. A key stored next to the DB would be backed up alongside it and
// defeat the purpose. See README "Cache encryption".

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'gcm1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// Cache the derived key against the raw env string so a changed OFW_CACHE_KEY
// (notably between tests) is picked up, without re-decoding base64 per field.
let cached: { raw: string; key: Buffer } | null = null;

/**
 * Resolve the 32-byte AES key from OFW_CACHE_KEY (base64), or null when unset.
 * Throws a clear error on a present-but-malformed key — a typo must fail loudly,
 * never silently fall back to writing plaintext.
 */
export function getCacheKey(): Buffer | null {
  const raw = process.env.OFW_CACHE_KEY;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    cached = null;
    return null;
  }
  const trimmed = raw.trim();
  if (cached && cached.raw === trimmed) return cached.key;
  // Buffer.from(..., 'base64') is lenient (never throws — it drops invalid
  // chars), so a malformed key surfaces as a wrong decoded length here.
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `OFW_CACHE_KEY must be base64 of exactly ${KEY_BYTES} bytes (decoded to ${key.length}). Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  cached = { raw: trimmed, key };
  return key;
}

/** True when a cache key is configured, i.e. content columns are encrypted at rest. */
export function isCacheEncryptionEnabled(): boolean {
  return getCacheKey() !== null;
}

/** Encrypt a string for storage. No-op (returns input) when no key is configured. */
export function encryptField(plaintext: string): string {
  const key = getCacheKey();
  if (!key) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt a stored value. Values without the `gcm1:` prefix are returned as-is
 * (legacy plaintext / encryption-off). An encrypted value with no key
 * configured, or a wrong key / tampered ciphertext, throws.
 */
export function decryptField(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = getCacheKey();
  if (!key) {
    throw new Error('Cache contains encrypted data but OFW_CACHE_KEY is not set — set the same key used to write it.');
  }
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt a cache field — OFW_CACHE_KEY is wrong or the cache is corrupt.');
  }
}

/** Encrypt a nullable field, preserving null. */
export function encryptNullable(v: string | null): string | null {
  return v === null ? null : encryptField(v);
}

/** Decrypt a nullable field, preserving null. */
export function decryptNullable(v: string | null): string | null {
  return v === null ? null : decryptField(v);
}
