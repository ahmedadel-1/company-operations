import { createHash } from 'node:crypto';

import { JiraCoordination } from '../jira/jira-coordination.js';
import type { KeyValueStore } from '../jira/jira-coordination.js';

/**
 * Shared short-lived state for the GitHub integration (Redis in deployments): setup states, the
 * encrypted installation-token cache and its creation lock, per-repository sync locks and
 * per-installation rate-limit pauses. Every API replica and worker sees the same values.
 */
export class GithubCoordination {
  private readonly locks: JiraCoordination;

  constructor(
    readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {
    this.locks = new JiraCoordination(store, now);
  }

  withLock<T>(key: string, options: { ttlMs: number; waitMs: number }, fn: () => Promise<T>): Promise<T> {
    return this.locks.withLock(key, options, fn);
  }

  tryLock(key: string, ttlMs: number): Promise<{ release: () => Promise<void> } | null> {
    return this.locks.tryLock(key, ttlMs);
  }

  /** Pauses all calls for an installation (GitHub asked us to back off). Only ever extends a pause. */
  async pause(installationRowId: string, untilMs: number): Promise<void> {
    const ttl = untilMs - this.now();
    if (ttl > 0) {
      const current = await this.pausedUntil(installationRowId);
      if (current === null || current < untilMs) {
        await this.store.set(pauseKey(installationRowId), String(untilMs), ttl);
      }
    }
  }

  async pausedUntil(installationRowId: string): Promise<number | null> {
    const value = await this.store.get(pauseKey(installationRowId));
    const until = value === null ? Number.NaN : Number(value);
    return Number.isFinite(until) && until > this.now() ? until : null;
  }
}

const pauseKey = (installationRowId: string): string => `github:pause:${installationRowId}`;
export const tokenCacheKey = (githubInstallationId: string): string => `github:token:${githubInstallationId}`;
export const tokenLockKey = (githubInstallationId: string): string => `github:token-lock:${githubInstallationId}`;
export const repoSyncLockKey = (repositoryId: string): string => `github:sync:${repositoryId}`;
export const setupStateKey = (state: string): string =>
  `github:setup:${createHash('sha256').update(state).digest('hex')}`;
