import type { GithubAccountType, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { integrationAdminMemberIds } from '../jira/jira-tokens.js';
import { GithubApiError } from './github-errors.js';
import { cancelGithubRuns, queueGithubRun } from './github-runs.js';
import type { GithubRuntime } from './github-runtime.js';
import type { InstallationWire, RepositoryWire } from './github-wire.js';

export type InstallationSyncOutcome = 'synced' | 'partial' | 'suspended' | 'deleted' | 'inactive';

export function accountType(wire: InstallationWire): GithubAccountType {
  const type = (wire.account?.type ?? wire.target_type ?? '').toLowerCase();
  if (type === 'user') {
    return 'USER';
  }
  return type === 'enterprise' ? 'ENTERPRISE' : 'ORGANIZATION';
}

export function accountLogin(wire: InstallationWire): string {
  const login = wire.account?.login ?? wire.account?.slug ?? wire.account?.name ?? `installation-${String(wire.id)}`;
  return login.slice(0, 100);
}

/** Installation facts copied from GitHub's view (never credentials). */
export function installationFacts(wire: InstallationWire) {
  return {
    accountId: BigInt(wire.account?.id ?? wire.id),
    accountLogin: accountLogin(wire),
    accountType: accountType(wire),
    repositorySelection: wire.repository_selection === 'all' ? ('ALL' as const) : ('SELECTED' as const),
    permissions: Object.fromEntries(Object.entries(wire.permissions).slice(0, 100)),
    events: wire.events.slice(0, 100),
  };
}

export function repositoryFacts(wire: RepositoryWire) {
  return {
    githubRepoId: BigInt(wire.id),
    nodeId: wire.node_id,
    ownerLogin: wire.owner.login,
    name: wire.name,
    fullName: wire.full_name,
    private: wire.private,
    archived: wire.archived,
    defaultBranch: wire.default_branch ?? null,
    htmlUrl: wire.html_url,
  };
}

const installationSelect = {
  id: true,
  githubInstallationId: true,
  status: true,
  accountLogin: true,
  version: true,
} as const satisfies Prisma.GithubInstallationSelect;

type InstallationRow = Prisma.GithubInstallationGetPayload<{ select: typeof installationSelect }>;

/** Notifies integration administrators once per installation state change (deduplicated by version). */
async function notifyAdmins(
  db: TenantDb,
  organizationId: string,
  installation: { id: string; accountLogin: string; version: number },
  type: 'GITHUB_INSTALLATION_SUSPENDED' | 'GITHUB_INSTALLATION_DELETED',
): Promise<void> {
  for (const memberId of await integrationAdminMemberIds(db, organizationId)) {
    await enqueueOutboxEvent(db, organizationId, {
      eventType: 'notification.requested',
      aggregateType: 'github_installation',
      aggregateId: installation.id,
      payload: {
        recipientMemberId: memberId,
        type,
        severity: 'WARNING',
        entityType: 'github_installation',
        entityId: installation.id,
        params: { account: installation.accountLogin },
        dedupeKey: `${type.toLowerCase()}:${installation.id}:${String(installation.version)}`,
        email: true,
      },
    });
  }
}

/**
 * Installation lifecycle and repository discovery (worker; also driven by `installation` and
 * `installation_repositories` webhooks, which only trigger a re-read of GitHub's authoritative
 * state, so out-of-order or repeated events converge to the same result).
 *
 * - Suspended on GitHub → SUSPENDED: nothing syncs, active runs are cancelled, admins are told.
 * - Uninstalled (404 for the App) → DELETED: repositories become REMOVED (history kept), runs stop.
 * - Repository access removed → the repository becomes REMOVED and stops syncing; its mappings and
 *   cached pull requests stay as history and it is never remapped to anything else.
 * - Repository access restored → AVAILABLE again; mapped repositories get a reconciliation run.
 * Repositories are keyed by GitHub's immutable id, so a rename updates the row.
 */
export class GithubInstallationSync {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: GithubRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async sync(installationId: string): Promise<InstallationSyncOutcome> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const row = await this.db.githubInstallation.findFirst({
      where: { organizationId, id: installationId },
      select: installationSelect,
    });
    if (row === null || row.status === 'DELETED' || row.status === 'DISCONNECTED') {
      return 'inactive';
    }
    const githubId = row.githubInstallationId.toString();
    let wire: InstallationWire;
    try {
      wire = await this.runtime.app.getInstallation(githubId);
    } catch (error) {
      if (error instanceof GithubApiError && error.kind === 'not_found') {
        await this.markDeleted(organizationId, row);
        return 'deleted';
      }
      await this.recordError(organizationId, row.id, error);
      throw error;
    }
    const facts = installationFacts(wire);
    if (wire.suspended_at !== null && wire.suspended_at !== undefined) {
      await this.markSuspended(organizationId, row, new Date(wire.suspended_at), facts);
      return 'suspended';
    }
    await this.db.githubInstallation.updateMany({
      where: { organizationId, id: row.id, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      data: {
        ...facts,
        status: 'ACTIVE',
        suspendedAt: null,
        ...(row.status === 'SUSPENDED' ? { version: { increment: 1 } } : {}),
      },
    });
    if (row.status === 'SUSPENDED') {
      await recordAudit(this.db, organizationId, {
        action: 'github.installation.unsuspended',
        entityType: 'github_installation',
        entityId: row.id,
        actor: { type: 'INTEGRATION' },
        metadata: { account: facts.accountLogin },
      });
    }
    let listing: { repositories: RepositoryWire[]; complete: boolean };
    try {
      listing = await this.runtime.clients
        .forInstallation({ installationRowId: row.id, githubInstallationId: githubId })
        .listRepositories();
    } catch (error) {
      await this.recordError(organizationId, row.id, error);
      throw error;
    }
    await this.applyRepositories(organizationId, row.id, listing.repositories, listing.complete);
    await this.db.githubInstallation.updateMany({
      where: { organizationId, id: row.id },
      data: {
        lastSyncedAt: this.now(),
        lastErrorCode: listing.complete ? null : 'repository_limit',
        lastErrorAt: listing.complete ? null : this.now(),
      },
    });
    return listing.complete ? 'synced' : 'partial';
  }

  /** Upserts the listed repositories; when the listing is complete, unlisted ones become REMOVED. */
  async applyRepositories(
    organizationId: string,
    installationId: string,
    repositories: readonly RepositoryWire[],
    complete: boolean,
  ): Promise<void> {
    const now = this.now();
    const listed = new Set<bigint>();
    for (const wire of repositories) {
      listed.add(BigInt(wire.id));
      await this.upsertRepository(organizationId, installationId, wire, now);
    }
    if (!complete) {
      return;
    }
    const cached = await this.db.githubRepository.findMany({
      where: { organizationId, installationId, status: 'AVAILABLE' },
      select: { id: true, githubRepoId: true },
    });
    for (const repo of cached) {
      if (!listed.has(repo.githubRepoId)) {
        await this.markRepositoryUnavailable(organizationId, repo.id, 'REMOVED');
      }
    }
  }

  async upsertRepository(
    organizationId: string,
    installationId: string,
    wire: RepositoryWire,
    now: Date,
  ): Promise<{ id: string; restored: boolean }> {
    const facts = repositoryFacts(wire);
    const existing = await this.db.githubRepository.findFirst({
      where: { organizationId, githubRepoId: facts.githubRepoId },
      select: { id: true, status: true },
    });
    if (existing === null) {
      try {
        const created = await this.db.githubRepository.create({
          data: { organizationId, installationId, ...facts },
          select: { id: true },
        });
        return { id: created.id, restored: false };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
        return this.upsertRepository(organizationId, installationId, wire, now);
      }
    }
    const restored = existing.status !== 'AVAILABLE';
    await this.db.githubRepository.updateMany({
      where: { organizationId, id: existing.id },
      data: { ...facts, installationId, status: 'AVAILABLE', unavailableAt: null },
    });
    if (restored) {
      await this.queueReconciliationIfMapped(organizationId, installationId, existing.id);
    }
    return { id: existing.id, restored };
  }

  async markRepositoryUnavailable(
    organizationId: string,
    repositoryId: string,
    status: 'REMOVED' | 'DELETED',
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const changed = await tx.githubRepository.updateMany({
        where: { organizationId, id: repositoryId, status: { not: 'DELETED' } },
        data: { status, unavailableAt: this.now() },
      });
      if (changed.count > 0) {
        await cancelGithubRuns(tx, organizationId, { repositoryId });
        await recordAudit(tx, organizationId, {
          action: status === 'DELETED' ? 'github.repository.deleted' : 'github.repository.access_removed',
          entityType: 'github_repository',
          entityId: repositoryId,
          actor: { type: 'INTEGRATION' },
        });
      }
    });
  }

  async markSuspended(
    organizationId: string,
    row: InstallationRow,
    suspendedAt: Date,
    facts: ReturnType<typeof installationFacts> | null,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const changed = await tx.githubInstallation.updateMany({
        where: { organizationId, id: row.id, status: 'ACTIVE' },
        data: { ...facts, status: 'SUSPENDED', suspendedAt, version: { increment: 1 } },
      });
      if (changed.count === 0) {
        return;
      }
      await cancelGithubRuns(tx, organizationId, { installationId: row.id });
      await recordAudit(tx, organizationId, {
        action: 'github.installation.suspended',
        entityType: 'github_installation',
        entityId: row.id,
        actor: { type: 'INTEGRATION' },
        metadata: { account: row.accountLogin },
      });
      await notifyAdmins(tx, organizationId, { ...row, version: row.version + 1 }, 'GITHUB_INSTALLATION_SUSPENDED');
    });
    await this.runtime.tokens.invalidate(row.githubInstallationId.toString());
  }

  async markDeleted(organizationId: string, row: InstallationRow): Promise<void> {
    const now = this.now();
    await this.db.$transaction(async (tx) => {
      const changed = await tx.githubInstallation.updateMany({
        where: { organizationId, id: row.id, status: { in: ['ACTIVE', 'SUSPENDED'] } },
        data: { status: 'DELETED', deletedAt: now, version: { increment: 1 } },
      });
      if (changed.count === 0) {
        return;
      }
      await tx.githubRepository.updateMany({
        where: { organizationId, installationId: row.id, status: 'AVAILABLE' },
        data: { status: 'REMOVED', unavailableAt: now },
      });
      await cancelGithubRuns(tx, organizationId, { installationId: row.id });
      await recordAudit(tx, organizationId, {
        action: 'github.installation.deleted',
        entityType: 'github_installation',
        entityId: row.id,
        actor: { type: 'INTEGRATION' },
        metadata: { account: row.accountLogin },
      });
      await notifyAdmins(tx, organizationId, { ...row, version: row.version + 1 }, 'GITHUB_INSTALLATION_DELETED');
    });
    await this.runtime.tokens.invalidate(row.githubInstallationId.toString());
  }

  async loadRow(organizationId: string, installationId: string): Promise<InstallationRow | null> {
    return this.db.githubInstallation.findFirst({
      where: { organizationId, id: installationId },
      select: installationSelect,
    });
  }

  private async queueReconciliationIfMapped(
    organizationId: string,
    installationId: string,
    repositoryId: string,
  ): Promise<void> {
    const mapped = await this.db.githubRepositoryMapping.findFirst({
      where: { organizationId, repositoryId, removedAt: null },
      select: { id: true },
    });
    if (mapped !== null) {
      const repo = await this.db.githubRepository.findFirst({
        where: { organizationId, id: repositoryId },
        select: { lastFullSyncAt: true },
      });
      await queueGithubRun(this.db, organizationId, {
        installationId,
        repositoryId,
        type: repo?.lastFullSyncAt === null || repo === null ? 'INITIAL_SYNC' : 'RECONCILIATION',
      });
    }
  }

  private async recordError(organizationId: string, installationId: string, error: unknown): Promise<void> {
    await this.db.githubInstallation.updateMany({
      where: { organizationId, id: installationId },
      data: {
        lastErrorCode: error instanceof GithubApiError ? error.code : 'sync_failed',
        lastErrorAt: this.now(),
      },
    });
  }
}
