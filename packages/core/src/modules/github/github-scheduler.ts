import type { PrismaClient } from '@company-ops/db';

import { organizationsWithGithubInstallations, staleGithubRuns } from '../../platform/db/sql/github-scan.js';
import type { AsyncLocalTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { enqueueGithubRun, enqueueInstallationSync, queueGithubRun } from './github-runs.js';

export interface GithubScheduleTotals {
  readonly organizations: number;
  readonly queued: number;
  readonly failedOrganizations: number;
}

const systemContext = (organizationId: string) => ({ organizationId, memberId: null, userId: null });

/**
 * Periodic GitHub work (worker schedulers). The organization scan is cross-tenant; everything else
 * runs in each organization's own system tenant context, and one failing organization does not stop
 * the others. Webhooks keep the cache fresh; these passes only repair what deliveries missed
 * (GitHub does not redeliver failed webhooks automatically).
 */
export class GithubScheduler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly db: TenantScopedClient,
    private readonly tenant: AsyncLocalTenantContext,
    private readonly onOrganizationError: (organizationId: string, error: unknown) => void,
  ) {}

  /**
   * Queues reconciliation for mapped, fully synced repositories whose last pass is older than
   * `intervalMs` (10% margin). Runs are serialized per repository by the active-run index and the
   * engine's per-installation pause keeps the total request rate within GitHub's limits.
   */
  async queueReconciliation(intervalMs: number, now: Date): Promise<GithubScheduleTotals> {
    const dueBefore = new Date(now.getTime() - intervalMs * 0.9);
    return this.forEachOrganization(async (organizationId) => {
      const repositories = await this.db.githubRepository.findMany({
        where: {
          organizationId,
          status: 'AVAILABLE',
          syncState: 'COMPLETED',
          installation: { status: 'ACTIVE' },
          mappings: { some: { removedAt: null } },
          OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: dueBefore } }],
        },
        select: { id: true, installationId: true },
        orderBy: { id: 'asc' },
        take: 500,
      });
      let queued = 0;
      for (const repo of repositories) {
        const runId = await queueGithubRun(this.db, organizationId, {
          installationId: repo.installationId,
          repositoryId: repo.id,
          type: 'RECONCILIATION',
        });
        queued += runId === null ? 0 : 1;
      }
      return queued;
    });
  }

  /** Re-reads installations (suspension, permissions, repository access) older than `intervalMs`. */
  async refreshInstallations(intervalMs: number, now: Date): Promise<GithubScheduleTotals> {
    const dueBefore = new Date(now.getTime() - intervalMs * 0.9);
    return this.forEachOrganization(async (organizationId) => {
      const installations = await this.db.githubInstallation.findMany({
        where: {
          organizationId,
          status: { in: ['ACTIVE', 'SUSPENDED'] },
          OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: dueBefore } }],
        },
        select: { id: true },
        take: 100,
      });
      await this.db.$transaction(async (tx) => {
        for (const installation of installations) {
          await enqueueInstallationSync(tx, organizationId, installation.id);
        }
      });
      return installations.length;
    });
  }

  /** Watchdog: re-enqueues runs without progress since `before`; they resume from their checkpoint. */
  async requeueStale(before: Date): Promise<number> {
    const stale = await staleGithubRuns(this.prisma, before);
    let requeued = 0;
    for (const { organizationId, runId } of stale) {
      try {
        await this.tenant.run(systemContext(organizationId), () =>
          this.db.$transaction(async (tx) => {
            const touched = await tx.githubSyncRun.updateMany({
              where: { organizationId, id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
              data: { updatedAt: new Date() },
            });
            if (touched.count > 0) {
              await enqueueGithubRun(tx, organizationId, runId);
              requeued += 1;
            }
          }),
        );
      } catch (error) {
        this.onOrganizationError(organizationId, error);
      }
    }
    return requeued;
  }

  private async forEachOrganization(fn: (organizationId: string) => Promise<number>): Promise<GithubScheduleTotals> {
    const organizations = await organizationsWithGithubInstallations(this.prisma);
    let queued = 0;
    let failedOrganizations = 0;
    for (const organizationId of organizations) {
      try {
        queued += await this.tenant.run(systemContext(organizationId), () => fn(organizationId));
      } catch (error) {
        failedOrganizations += 1;
        this.onOrganizationError(organizationId, error);
      }
    }
    return { organizations: organizations.length, queued, failedOrganizations };
  }
}
