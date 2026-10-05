import { randomBytes } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EnvelopeCipher } from '@company-ops/core';

import { SessionStore } from '../src/auth/session/session.store.js';
import type { NewSession } from '../src/auth/session/session.types.js';

import { startTestRedis } from './support/stack.js';
import type { StartedRedis } from './support/stack.js';

const MINUTE = 60_000;
const IDLE = 30 * MINUTE;
const ABSOLUTE = 12 * 60 * MINUTE;

const input: NewSession = {
  userId: 'user-1',
  organizationId: 'org-1',
  memberId: 'member-1',
  authzVersion: 1,
  roleKeys: ['EMPLOYEE'],
  permissions: { 'employee.view': ['ORG'] },
  acr: 'pwd',
  mfaAuthenticatedAt: null,
  idpSessionId: 'kc-session-1',
  idToken: 'header.payload.signature',
};

describe('SessionStore on real Redis (idle 30 min, absolute 12 h)', () => {
  let redisContainer: StartedRedis;
  let redis: Redis;
  let clock: number;
  let store: SessionStore;

  beforeAll(async () => {
    redisContainer = await startTestRedis();
    redis = new Redis(redisContainer.url);
  });

  afterAll(async () => {
    redis.disconnect();
    await redisContainer.stop();
  });

  beforeEach(async () => {
    await redis.flushdb();
    clock = Date.UTC(2026, 9, 2, 8, 0, 0);
    const cipher = new EnvelopeCipher({ id: 'test', key: randomBytes(32) });
    store = new SessionStore(redis, cipher, { idleMs: IDLE, absoluteMs: ABSOLUTE }, () => clock);
  });

  it('stores only a hash of the session id and keeps the ID token encrypted', async () => {
    const { id, record } = await store.create(input);
    const keys = await redis.keys('ops:sess:*');
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(id);
    const raw = (await redis.get(keys[0] ?? '')) ?? '';
    expect(raw).not.toContain(input.idToken ?? '');
    expect(store.decryptIdToken(record)).toBe(input.idToken);
    expect(await redis.pttl(keys[0] ?? '')).toBeLessThanOrEqual(IDLE);
  });

  it('expires after 30 idle minutes', async () => {
    const { id } = await store.create(input);
    clock += IDLE - 1;
    expect(await store.load(id)).not.toBeNull();
    clock += IDLE;
    expect(await store.load(id)).toBeNull();
    expect(await redis.keys('ops:sess:*')).toHaveLength(0);
  });

  it('slides the idle window on activity but never beyond the 12-hour absolute limit', async () => {
    const { id, record } = await store.create(input);
    for (let elapsed = 0; elapsed + 20 * MINUTE < ABSOLUTE; elapsed += 20 * MINUTE) {
      clock += 20 * MINUTE;
      expect(await store.load(id)).not.toBeNull();
    }
    clock = record.absoluteExpiresAt;
    expect(await store.load(id)).toBeNull();
  });

  it('rotation keeps the absolute deadline, issues a new CSRF token and kills the old id', async () => {
    const created = await store.create(input);
    clock += 5 * MINUTE;
    const rotated = await store.rotate(created.id, created.record, { organizationId: 'org-2' });
    expect(rotated.id).not.toBe(created.id);
    expect(rotated.record.csrfToken).not.toBe(created.record.csrfToken);
    expect(rotated.record.absoluteExpiresAt).toBe(created.record.absoluteExpiresAt);
    expect(await store.load(created.id)).toBeNull();
    expect((await store.load(rotated.id))?.organizationId).toBe('org-2');
  });

  it('back-channel logout removes every session of the IdP session, including rotated ones', async () => {
    const first = await store.create(input);
    const rotated = await store.rotate(first.id, first.record, { authzVersion: 2 });
    const other = await store.create({ ...input, idpSessionId: 'kc-session-2' });
    const removed = await store.destroyByIdpSession('kc-session-1');
    expect(removed).toHaveLength(1);
    expect(await store.load(rotated.id)).toBeNull();
    expect(await store.load(other.id)).not.toBeNull();
  });
});
