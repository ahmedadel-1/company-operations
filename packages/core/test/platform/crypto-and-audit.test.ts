import { randomBytes } from 'node:crypto';

import type { Prisma } from '@company-ops/db';
import { describe, expect, it } from 'vitest';

import { recordAudit } from '../../src/platform/audit/audit-writer.js';
import type { AuditLogStore } from '../../src/platform/audit/audit-writer.js';
import { redactAuditMetadata } from '../../src/platform/audit/redact.js';
import { EnvelopeCipher } from '../../src/platform/crypto/envelope-cipher.js';

describe('EnvelopeCipher', () => {
  const key = { id: 'k1', key: randomBytes(32) };

  it('round-trips and binds ciphertext to its additional authenticated data', () => {
    const cipher = new EnvelopeCipher(key);
    const envelope = cipher.encrypt('id-token-value', 'session:abc');
    expect(envelope.startsWith('v1.k1.')).toBe(true);
    expect(envelope).not.toContain('id-token-value');
    expect(cipher.decrypt(envelope, 'session:abc')).toBe('id-token-value');
    expect(() => cipher.decrypt(envelope, 'session:other')).toThrow();
  });

  it('uses a fresh IV per encryption', () => {
    const cipher = new EnvelopeCipher(key);
    expect(cipher.encrypt('x', 'a')).not.toBe(cipher.encrypt('x', 'a'));
  });

  it('detects tampering, malformed envelopes and unknown keys', () => {
    const cipher = new EnvelopeCipher(key);
    const parts = cipher.encrypt('secret', 'a').split('.');
    const tamperedCiphertext = Buffer.from(parts[4] ?? '', 'base64url');
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1;
    parts[4] = tamperedCiphertext.toString('base64url');
    expect(() => cipher.decrypt(parts.join('.'), 'a')).toThrow();
    expect(() => cipher.decrypt('v1.k1.abc', 'a')).toThrow(/Malformed/);
    const other = new EnvelopeCipher({ id: 'k2', key: randomBytes(32) });
    expect(() => cipher.decrypt(other.encrypt('x', 'a'), 'a')).toThrow(/Unknown encryption key/);
  });

  it('decrypts with a previous key after rotation', () => {
    const old = new EnvelopeCipher(key);
    const rotated = new EnvelopeCipher({ id: 'k2', key: randomBytes(32) }, [key]);
    expect(rotated.decrypt(old.encrypt('x', 'a'), 'a')).toBe('x');
  });

  it('rejects keys of the wrong size', () => {
    expect(() => new EnvelopeCipher({ id: 'k1', key: randomBytes(16) })).toThrow(/32 bytes/);
    expect(() => EnvelopeCipher.fromBase64('k1', randomBytes(31).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('redactAuditMetadata', () => {
  it('drops sensitive keys at any depth', () => {
    const result = redactAuditMetadata({
      roleKey: 'HR_ADMIN',
      idToken: 'x',
      nested: { clientSecret: 'x', Authorization: 'x', cookieHeader: 'x', password: 'x', private_key: 'x', ok: 1 },
      list: [{ refresh_token: 'x', keep: true }],
    });
    expect(result).toEqual({ roleKey: 'HR_ADMIN', nested: { ok: 1 }, list: [{ keep: true }] });
  });

  it('caps strings and depth and normalizes non-JSON values', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const result = redactAuditMetadata({
      long: 'x'.repeat(5000),
      deep,
      when: new Date(0),
      nan: Number.NaN,
      fn: () => 1,
    });
    expect(result.long).toHaveLength(2001);
    expect(JSON.stringify(result.deep)).toContain('[TRUNCATED]');
    expect(result.when).toBe('1970-01-01T00:00:00.000Z');
    expect(result.nan).toBeNull();
    expect('fn' in result).toBe(false);
  });
});

describe('recordAudit', () => {
  it('writes redacted metadata and request facts only', async () => {
    const writes: Prisma.AuditLogUncheckedCreateInput[] = [];
    const store: AuditLogStore = {
      auditLog: {
        create: (args) => {
          writes.push(args.data);
          return Promise.resolve({ id: 'row-1' });
        },
      },
    };
    const id = await recordAudit(store, 'org-1', {
      action: 'auth.login.succeeded',
      entityType: 'user',
      entityId: 'u1',
      actor: { type: 'USER', userId: 'u1', memberId: 'm1' },
      metadata: { acr: 'mfa', accessToken: 'leak' },
      context: { requestId: 'r1', ip: '127.0.0.1', userAgent: 'ua'.repeat(400) },
    });
    expect(id).toBe('row-1');
    expect(writes).toHaveLength(1);
    const data = writes[0];
    expect(data).toMatchObject({
      organizationId: 'org-1',
      actorType: 'USER',
      actorUserId: 'u1',
      actorMemberId: 'm1',
      metadata: { acr: 'mfa' },
      requestId: 'r1',
      ip: '127.0.0.1',
    });
    expect(data?.userAgent).toHaveLength(512);
  });
});
