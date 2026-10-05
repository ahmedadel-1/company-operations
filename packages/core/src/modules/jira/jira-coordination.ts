import { randomBytes } from 'node:crypto';

/**
 * Short-lived shared state for the Jira integration (Redis in deployments): OAuth state and pending
 * grants, the per-connection token-refresh lock, the per-connection sync lock and rate-limit pauses.
 * Every process (API replicas, workers) sees the same values, so coordination is connection-wide.
 */
export interface KeyValueStore {
  /** Sets the key only when absent. */
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  /** Reads and deletes atomically (single use). */
  take(key: string): Promise<string | null>;
  /** Deletes the key only when it still holds `value` (lock release). */
  deleteIfEquals(key: string, value: string): Promise<void>;
}

/** The ioredis calls used by {@link redisKeyValueStore}. */
export interface RedisCommands {
  set(key: string, value: string, mode: 'PX', ttlMs: number, condition: 'NX'): Promise<'OK' | null>;
  psetex(key: string, ttlMs: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

const COMPARE_AND_DELETE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

export function redisKeyValueStore(redis: RedisCommands): KeyValueStore {
  return {
    setIfAbsent: async (key, value, ttlMs) => (await redis.set(key, value, 'PX', ttlMs, 'NX')) === 'OK',
    set: async (key, value, ttlMs) => {
      await redis.psetex(key, ttlMs, value);
    },
    get: (key) => redis.get(key),
    take: (key) => redis.getdel(key),
    deleteIfEquals: async (key, value) => {
      await redis.eval(COMPARE_AND_DELETE, 1, key, value);
    },
  };
}

/** Process-local store for tests and single-process tools. */
export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    if (this.live(key) !== null) {
      return Promise.resolve(false);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    return Promise.resolve(true);
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key));
  }

  take(key: string): Promise<string | null> {
    const value = this.live(key);
    this.entries.delete(key);
    return Promise.resolve(value);
  }

  deleteIfEquals(key: string, value: string): Promise<void> {
    if (this.live(key) === value) {
      this.entries.delete(key);
    }
    return Promise.resolve();
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Thrown when a lock could not be acquired in time; callers retry later. */
export class LockBusyError extends Error {
  constructor(key: string) {
    super(`Lock is busy: ${key}`);
    this.name = 'LockBusyError';
  }
}

/** Connection-wide coordination built on a {@link KeyValueStore}. */
export class JiraCoordination {
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Runs `fn` while holding a lock. Waits up to `waitMs` for it; the TTL bounds how long a crashed
   * holder can block others. Release only deletes our own token.
   */
  async withLock<T>(key: string, options: { ttlMs: number; waitMs: number }, fn: () => Promise<T>): Promise<T> {
    const token = randomBytes(16).toString('hex');
    const deadline = this.now() + options.waitMs;
    while (!(await this.store.setIfAbsent(key, token, options.ttlMs))) {
      if (this.now() >= deadline) {
        throw new LockBusyError(key);
      }
      await sleep(100);
    }
    try {
      return await fn();
    } finally {
      await this.store.deleteIfEquals(key, token);
    }
  }

  /** Tries the lock once; null when someone else holds it. */
  async tryLock(key: string, ttlMs: number): Promise<{ release: () => Promise<void> } | null> {
    const token = randomBytes(16).toString('hex');
    if (!(await this.store.setIfAbsent(key, token, ttlMs))) {
      return null;
    }
    return { release: () => this.store.deleteIfEquals(key, token) };
  }

  /** Pauses all calls for a connection (Jira asked us to back off). */
  async pause(connectionId: string, untilMs: number): Promise<void> {
    const ttl = untilMs - this.now();
    if (ttl > 0) {
      const current = await this.pausedUntil(connectionId);
      if (current === null || current < untilMs) {
        await this.store.set(pauseKey(connectionId), String(untilMs), ttl);
      }
    }
  }

  /** Epoch ms until which the connection is paused, or null. */
  async pausedUntil(connectionId: string): Promise<number | null> {
    const value = await this.store.get(pauseKey(connectionId));
    const until = value === null ? Number.NaN : Number(value);
    return Number.isFinite(until) && until > this.now() ? until : null;
  }
}

const pauseKey = (connectionId: string): string => `jira:pause:${connectionId}`;
export const refreshLockKey = (connectionId: string): string => `jira:refresh:${connectionId}`;
export const syncLockKey = (connectionId: string): string => `jira:sync:${connectionId}`;
