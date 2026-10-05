import { createHash, randomBytes } from 'node:crypto';

import type { ChainableCommander, Redis } from 'ioredis';

import type { EnvelopeCipher } from '@company-ops/core';

import { parseSessionRecord } from './session.types.js';
import type { NewSession, SessionRecord } from './session.types.js';

export interface SessionTimeouts {
  readonly idleMs: number;
  readonly absoluteMs: number;
}

const SESSION_PREFIX = 'ops:sess:';
const IDP_INDEX_PREFIX = 'ops:sess-idp:';
/** Sliding expiry is refreshed at most once per interval to avoid a Redis write per request. */
const TOUCH_INTERVAL_MS = 60_000;

/** `exec()` reports per-command failures in its result instead of rejecting. */
async function execAll(multi: ChainableCommander): Promise<void> {
  const results = await multi.exec();
  if (results === null) {
    throw new Error('Redis transaction was aborted.');
  }
  for (const [error] of results) {
    if (error !== null) {
      throw error;
    }
  }
}

/** 256-bit, URL-safe. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Redis never sees the raw session id: a leaked key listing cannot be replayed as a cookie. */
const sessionKey = (sessionId: string): string => `${SESSION_PREFIX}${digest(sessionId)}`;
const idpIndexKey = (idpSessionId: string): string => `${IDP_INDEX_PREFIX}${digest(idpSessionId)}`;

/**
 * Redis-backed sessions (SECURITY §3.3): opaque 256-bit ids, 30-minute idle and 12-hour absolute
 * expiry (configurable), rotation on privilege changes, and an index by Keycloak session id for
 * back-channel logout. The ID token is stored encrypted and only used as logout hint.
 */
export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly cipher: EnvelopeCipher,
    private readonly timeouts: SessionTimeouts,
    private readonly now: () => number = Date.now,
  ) {}

  async create(input: NewSession): Promise<{ id: string; record: SessionRecord }> {
    const now = this.now();
    const { idToken, ...rest } = input;
    const base = {
      ...rest,
      v: 1 as const,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: now + this.timeouts.absoluteMs,
    };
    const record: SessionRecord = {
      ...base,
      csrfToken: newOpaqueToken(),
      idTokenEnc: idToken === null ? null : this.cipher.encrypt(idToken, this.aad(base)),
    };
    const id = newOpaqueToken();
    await this.write(id, record, true);
    return { id, record };
  }

  /** Returns the live session or null (unknown, expired, malformed). Refreshes the idle window. */
  async load(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    if (raw === null) {
      return null;
    }
    const record = parseSessionRecord(raw);
    const now = this.now();
    if (record === null || now >= record.absoluteExpiresAt || now - record.lastSeenAt >= this.timeouts.idleMs) {
      await this.redis.del(sessionKey(sessionId));
      return null;
    }
    if (now - record.lastSeenAt >= TOUCH_INTERVAL_MS) {
      const touched = { ...record, lastSeenAt: now };
      await this.write(sessionId, touched, false);
      return touched;
    }
    return record;
  }

  /**
   * The live session without refreshing the idle window (long-lived streams re-check their session
   * with this, so an open stream never keeps an idle session alive).
   */
  async peek(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(sessionKey(sessionId));
    const record = raw === null ? null : parseSessionRecord(raw);
    const now = this.now();
    if (record === null || now >= record.absoluteExpiresAt || now - record.lastSeenAt >= this.timeouts.idleMs) {
      return null;
    }
    return record;
  }

  /**
   * Issues a new session id (and CSRF token) carrying the updated state and deletes the old id in
   * the same transaction (session fixation, SECURITY §3.3). Used on organization switch and
   * permission changes; login always creates a brand-new session.
   */
  async rotate(
    oldSessionId: string,
    current: SessionRecord,
    changes: Partial<Omit<SessionRecord, 'v' | 'csrfToken' | 'createdAt' | 'absoluteExpiresAt' | 'userId'>>,
  ): Promise<{ id: string; record: SessionRecord }> {
    const record: SessionRecord = { ...current, ...changes, csrfToken: newOpaqueToken(), lastSeenAt: this.now() };
    const id = newOpaqueToken();
    const ttl = this.ttlMs(record);
    const multi = this.redis
      .multi()
      .del(sessionKey(oldSessionId))
      .set(sessionKey(id), JSON.stringify(record), 'PX', ttl);
    if (current.idpSessionId !== null) {
      multi.srem(idpIndexKey(current.idpSessionId), digest(oldSessionId));
    }
    if (record.idpSessionId !== null) {
      multi
        .sadd(idpIndexKey(record.idpSessionId), digest(id))
        .pexpire(idpIndexKey(record.idpSessionId), this.timeouts.absoluteMs);
    }
    await execAll(multi);
    return { id, record };
  }

  async destroy(sessionId: string, record?: SessionRecord | null): Promise<void> {
    const multi = this.redis.multi().del(sessionKey(sessionId));
    if (record?.idpSessionId != null) {
      multi.srem(idpIndexKey(record.idpSessionId), digest(sessionId));
    }
    await execAll(multi);
  }

  /** Back-channel logout: removes every session created from one Keycloak session; returns them. */
  async destroyByIdpSession(idpSessionId: string): Promise<SessionRecord[]> {
    const index = idpIndexKey(idpSessionId);
    const keys = (await this.redis.smembers(index)).map((hash) => `${SESSION_PREFIX}${hash}`);
    const raws = keys.length === 0 ? [] : await this.redis.mget(...keys);
    const multi = this.redis.multi().del(index);
    for (const key of keys) {
      multi.del(key);
    }
    await execAll(multi);
    return raws.flatMap((raw) => {
      const record = raw === null ? null : parseSessionRecord(raw);
      return record === null ? [] : [record];
    });
  }

  decryptIdToken(record: SessionRecord): string | null {
    if (record.idTokenEnc === null) {
      return null;
    }
    try {
      return this.cipher.decrypt(record.idTokenEnc, this.aad(record));
    } catch {
      return null;
    }
  }

  /** Remaining cookie lifetime: the absolute expiry (the idle window is enforced server-side). */
  cookieMaxAgeMs(record: SessionRecord): number {
    return Math.max(0, record.absoluteExpiresAt - this.now());
  }

  private aad(record: Pick<SessionRecord, 'userId' | 'createdAt'>): string {
    return `ops-session-id-token:${record.userId}:${String(record.createdAt)}`;
  }

  private ttlMs(record: SessionRecord): number {
    const now = this.now();
    return Math.max(1, Math.min(this.timeouts.idleMs, record.absoluteExpiresAt - now));
  }

  private async write(sessionId: string, record: SessionRecord, index: boolean): Promise<void> {
    const multi = this.redis.multi().set(sessionKey(sessionId), JSON.stringify(record), 'PX', this.ttlMs(record));
    if (index && record.idpSessionId !== null) {
      const key = idpIndexKey(record.idpSessionId);
      multi.sadd(key, digest(sessionId)).pexpire(key, this.timeouts.absoluteMs);
    }
    await execAll(multi);
  }
}
