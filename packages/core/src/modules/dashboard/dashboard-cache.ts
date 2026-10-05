import type { PermissionKey } from '@company-ops/shared';

import type { Principal } from '../authorization/policy.js';
import { dashboardCacheKey, scopeDescriptor, scopeHash, versionKey, versionsTag } from './engine/cache-keys.js';
import type { DashboardDomain } from './engine/cache-keys.js';

/** The few cache operations dashboards need (Redis in deployments). */
export interface DashboardCacheStore {
  get(key: string): Promise<string | null>;
  mget(keys: readonly string[]): Promise<(string | null)[]>;
  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
  increment(key: string): Promise<void>;
}

/** The ioredis calls used by {@link redisDashboardCacheStore}. */
export interface DashboardRedisCommands {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
  incr(key: string): Promise<number>;
}

export function redisDashboardCacheStore(redis: DashboardRedisCommands): DashboardCacheStore {
  return {
    get: (key) => redis.get(key),
    mget: (keys) => (keys.length === 0 ? Promise.resolve([]) : redis.mget(...keys)),
    setWithTtl: async (key, value, ttlSeconds) => {
      await redis.set(key, value, 'EX', ttlSeconds);
    },
    increment: async (key) => {
      await redis.incr(key);
    },
  };
}

/** Process-local store for tests. */
export class InMemoryDashboardCacheStore implements DashboardCacheStore {
  readonly entries = new Map<string, { value: string; expiresAt: number | null }>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): string | null {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key));
  }

  mget(keys: readonly string[]): Promise<(string | null)[]> {
    return Promise.resolve(keys.map((key) => this.live(key)));
  }

  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  increment(key: string): Promise<void> {
    const current = Number(this.live(key) ?? '0');
    this.entries.set(key, { value: String(current + 1), expiresAt: null });
    return Promise.resolve();
  }
}

/** Short TTL: version bumps retire entries early; the TTL bounds staleness of untracked changes (time passing). */
export const DASHBOARD_CACHE_TTL_SECONDS = 60;
/** A slow cache must never slow a dashboard down: past this, the source queries answer. */
export const DASHBOARD_CACHE_TIMEOUT_MS = 250;

export type CacheErrorReporter = (operation: string, error: unknown) => void;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Dashboard cache timed out after ${String(ms)} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface CachedRead {
  /** Dashboard name in the key (`me`, `support`, ...). */
  readonly dashboard: string;
  readonly principal: Principal;
  /** Every permission whose scope changes the result (including those that only gate a section). */
  readonly permissions: readonly PermissionKey[];
  /** The result contains caller-specific data (own requests, assigned tickets, ...). */
  readonly personal: boolean;
  /** Domains whose change events invalidate the result. */
  readonly domains: readonly DashboardDomain[];
  /** Extra key material (query parameters such as a trend range). */
  readonly variant?: string;
}

/**
 * Read-through cache for dashboard results (ADR-0023). Keys start with the tenant, embed a hash of the
 * caller's effective scopes for the permissions involved, and the current version of each data domain;
 * a change event bumps the domain version, so the next read misses. Any cache failure (error or
 * timeout) falls back to computing from the source tables — the cache can make reads faster, never
 * wrong or unavailable.
 */
export class DashboardCache {
  constructor(
    private readonly store: DashboardCacheStore | null,
    private readonly reportError: CacheErrorReporter = () => undefined,
    private readonly ttlSeconds: number = DASHBOARD_CACHE_TTL_SECONDS,
    private readonly timeoutMs: number = DASHBOARD_CACHE_TIMEOUT_MS,
  ) {}

  async getOrCompute<T>(read: CachedRead, compute: () => Promise<T>): Promise<T> {
    const store = this.store;
    if (store === null) {
      return compute();
    }
    const key = await this.keyFor(store, read);
    if (key !== null) {
      try {
        const hit = await withTimeout(store.get(key), this.timeoutMs);
        if (hit !== null) {
          return JSON.parse(hit) as T;
        }
      } catch (error: unknown) {
        this.reportError('get', error);
      }
    }
    const value = await compute();
    if (key !== null) {
      try {
        await withTimeout(store.setWithTtl(key, JSON.stringify(value), this.ttlSeconds), this.timeoutMs);
      } catch (error: unknown) {
        this.reportError('set', error);
      }
    }
    return value;
  }

  private async keyFor(store: DashboardCacheStore, read: CachedRead): Promise<string | null> {
    const organizationId = read.principal.organizationId;
    try {
      const versions = await withTimeout(
        store.mget(read.domains.map((domain) => versionKey(organizationId, domain))),
        this.timeoutMs,
      );
      const scope = scopeHash(scopeDescriptor(read.principal, read.permissions, read.personal));
      const name = read.variant === undefined ? read.dashboard : `${read.dashboard}.${read.variant}`;
      return dashboardCacheKey(organizationId, name, scope, versionsTag(read.domains, versions));
    } catch (error: unknown) {
      this.reportError('versions', error);
      return null;
    }
  }
}

/** Retires an organization's cached dashboards for the given domains (worker consumers call it). */
export type DashboardInvalidator = (organizationId: string, domains: readonly DashboardDomain[]) => Promise<void>;

export function dashboardInvalidator(
  store: DashboardCacheStore,
  reportError: CacheErrorReporter = () => undefined,
): DashboardInvalidator {
  return (organizationId, domains) => bumpDashboardVersions(store, organizationId, domains, reportError);
}

/**
 * Retires cached dashboards of the organization that depend on the domains. Failures are reported and
 * swallowed: entries then expire by TTL, and the change itself has already committed.
 */
export async function bumpDashboardVersions(
  store: DashboardCacheStore,
  organizationId: string,
  domains: readonly DashboardDomain[],
  reportError: CacheErrorReporter = () => undefined,
): Promise<void> {
  for (const domain of new Set(domains)) {
    try {
      await withTimeout(store.increment(versionKey(organizationId, domain)), DASHBOARD_CACHE_TIMEOUT_MS * 4);
    } catch (error: unknown) {
      reportError('bump', error);
    }
  }
}
