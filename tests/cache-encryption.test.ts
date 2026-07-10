import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getCacheDbPath } from '../src/config.js';
import {
  openCache, closeCache,
  upsertMessage, getMessage, listMessages, countMessages,
  upsertDraft, getDraft,
  upsertAttachmentForMessage, getAttachment,
} from '../src/cache.js';
import { sampleMessageRow } from './_fixtures.js';

const KEY = randomBytes(32).toString('base64');

let tmp: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ofw-enc-'));
  saved = {
    dir: process.env.OFW_CACHE_DIR,
    user: process.env.OFW_USERNAME,
    key: process.env.OFW_CACHE_KEY,
  };
  process.env.OFW_CACHE_DIR = tmp;
  process.env.OFW_USERNAME = 'enc@example.com';
  process.env.OFW_CACHE_KEY = KEY;
});

afterEach(() => {
  closeCache();
  for (const [k, envName] of [['dir', 'OFW_CACHE_DIR'], ['user', 'OFW_USERNAME'], ['key', 'OFW_CACHE_KEY']] as const) {
    if (saved[k] === undefined) delete process.env[envName];
    else process.env[envName] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('encrypted cache round-trips', () => {
  it('stores message content as ciphertext on disk but reads it back in the clear', () => {
    upsertMessage(sampleMessageRow({
      id: 1, subject: 'PLAINSUBJECT_zz', body: 'PLAINBODY_marker_yy',
      recipients: [{ userId: 9, name: 'RECIPIENT_NAME_xx', viewedAt: null }],
    }));
    // Read back through the API — decrypted.
    const got = getMessage(1)!;
    expect(got.subject).toBe('PLAINSUBJECT_zz');
    expect(got.body).toBe('PLAINBODY_marker_yy');
    expect(got.recipients[0].name).toBe('RECIPIENT_NAME_xx');

    // Read the raw DB file — the plaintext markers must NOT appear.
    closeCache();
    const raw = readFileSync(getCacheDbPath()).toString('latin1');
    expect(raw).not.toContain('PLAINSUBJECT_zz');
    expect(raw).not.toContain('PLAINBODY_marker_yy');
    expect(raw).not.toContain('RECIPIENT_NAME_xx');
  });

  it('round-trips a null body', () => {
    upsertMessage(sampleMessageRow({ id: 2, body: null }));
    expect(getMessage(2)!.body).toBeNull();
  });

  it('round-trips drafts and attachments encrypted', () => {
    upsertDraft({
      id: 5, subject: 'DRAFTSUBJ_aa', body: 'DRAFTBODY_bb',
      recipients: [{ userId: 1, name: 'Bob', viewedAt: null }],
      replyToId: null, modifiedAt: '2026-05-04T00:00:00Z', listData: { d: 1 },
    });
    const d = getDraft(5)!;
    expect(d.subject).toBe('DRAFTSUBJ_aa');
    expect(d.body).toBe('DRAFTBODY_bb');

    upsertAttachmentForMessage({
      fileId: 7, fileName: 'ATTACHNAME_cc.pdf', label: 'LABEL_dd',
      mimeType: 'application/pdf', sizeBytes: 10, metadata: { k: 'v' }, messageId: 1,
    });
    const a = getAttachment(7)!;
    expect(a.fileName).toBe('ATTACHNAME_cc.pdf');
    expect(a.label).toBe('LABEL_dd');
    expect(a.messageIds).toEqual([1]);

    closeCache();
    const raw = readFileSync(getCacheDbPath()).toString('latin1');
    expect(raw).not.toContain('DRAFTBODY_bb');
    expect(raw).not.toContain('ATTACHNAME_cc');
  });
});

describe('encrypted search (in-memory filter path)', () => {
  beforeEach(() => {
    upsertMessage(sampleMessageRow({ id: 10, folder: 'inbox', subject: 'Doctor appointment', body: 'bring insurance card', sentAt: '2026-05-01T00:00:00Z' }));
    upsertMessage(sampleMessageRow({ id: 11, folder: 'inbox', subject: 'Soccer practice', body: 'DOCTOR note needed', sentAt: '2026-05-02T00:00:00Z' }));
    upsertMessage(sampleMessageRow({ id: 12, folder: 'inbox', subject: 'Grocery list', body: 'milk and eggs', sentAt: '2026-05-03T00:00:00Z' }));
  });

  it('matches the query against decrypted subject (case-insensitive)', () => {
    const res = listMessages({ page: 1, size: 50, q: 'doctor' });
    const ids = res.map((m) => m.id).sort();
    expect(ids).toEqual([10, 11]); // 10 by subject, 11 by body
  });

  it('counts matches through the same in-memory path', () => {
    expect(countMessages({ q: 'doctor' })).toBe(2);
    expect(countMessages({ q: 'nonexistent' })).toBe(0);
  });

  it('paginates the in-memory filtered set', () => {
    const page1 = listMessages({ page: 1, size: 2, q: 'doctor' });
    expect(page1.length).toBe(2);
    const page2 = listMessages({ page: 2, size: 2, q: 'doctor' });
    expect(page2.length).toBe(0);
  });

  it('still uses the SQL path (no q) with encryption on', () => {
    expect(listMessages({ page: 1, size: 50 }).length).toBe(3);
    expect(countMessages({})).toBe(3);
  });

  it('evaluates the body-null branch when the subject does not match', () => {
    // Null body + a subject that does NOT contain the query forces the
    // `(m.body ?? '')` null branch to evaluate (no `||` short-circuit).
    upsertMessage(sampleMessageRow({ id: 13, folder: 'inbox', subject: 'Weather chat', body: null, sentAt: '2026-05-05T00:00:00Z' }));
    const ids = listMessages({ page: 1, size: 50, q: 'milk' }).map((m) => m.id);
    expect(ids).toEqual([12]); // id 13 excluded via the null-body branch; id 12 matches by body
  });
});

describe('mixed legacy-plaintext + encrypted rows', () => {
  it('reads rows written before the key was set (passthrough) and searches across both', () => {
    // Write one row with NO key (legacy plaintext), then enable the key.
    delete process.env.OFW_CACHE_KEY;
    openCache();
    upsertMessage(sampleMessageRow({ id: 20, subject: 'legacy DOCTOR row', body: 'old body' }));
    // Enable encryption; new row is ciphertext.
    process.env.OFW_CACHE_KEY = KEY;
    upsertMessage(sampleMessageRow({ id: 21, subject: 'new DOCTOR row', body: 'new body' }));

    expect(getMessage(20)!.subject).toBe('legacy DOCTOR row'); // plaintext passthrough
    expect(getMessage(21)!.subject).toBe('new DOCTOR row');    // decrypted
    const ids = listMessages({ page: 1, size: 50, q: 'doctor' }).map((m) => m.id).sort();
    expect(ids).toEqual([20, 21]);
  });
});
