import type { JiraSyncRunType, PrismaClient } from '@company-ops/db';

import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { organizationsWithJiraConnections, staleJiraRuns } from '../../platform/db/sql/jira-scan.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { AsyncLocalTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';

export interface ScheduleTotals {
  readonly organizations: number;
  readonly queued: number;
  readonly failedOrganizations: number;
}

const systemContext = (organizationId: string) => ({ organizationId, memberId: null, userId: null });

/** Creates a QUEUED run and its outbox event; null when the mapping already has an active run. */
export async function queueSyncRun(
  db: TenantScopedClient,
  organizationId: string,
  input: {
    connectionId: string;
    mappingId: string;
    type: JiraSyncRunType;
    requestedByMemberId?: string | null;
    requestId?: string | null;
    resumedFromRunId?: string | null;
    lastCursor?: Readonly<Record<string, string>>;
  },
): Promise<string | null> {
  try {
    return await db.$transaction(async (tx) => {
      const run = await tx.jiraSyncRun.create({
        data: {
          organizationId,
          connectionId: input.connectionId,
          mappingId: input.mappingId,
          type: input.type,
          requestedByMemberId: input.requestedByMemberId ?? null,
          requestId: input.requestId ?? null,
          resumedFromRunId: input.resumedFromRunId ?? null,
          lastCursor: { ...input.lastCursor },
        },
        select: { id: true },
      });
      await enqueueRun(tx, organizationId, run.id);
      return run.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

export async function enqueueRun(db: TenantDb, organizationId: string, runId: string): Promise<void> {
  await enqueueOutboxEvent(db, organizationId, {
    eventType: 'jira.sync.requested',
    aggregateType: 'jira_sync_run',
    aggregateId: runId,
    payload: { runId },
  });
}

/**
 * Periodic Jira work (worker schedulers). The organization scan is cross-tenant; everything else
 * runs in each organization's own system tenant context, and one failing organization does not
 * stop the others.
 */
export class JiraScheduler {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly db: TenantScopedClient,
    private readonly tenant: AsyncLocalTenantContext,
    private readonly onOrganizationError: (organizationId: string, error: unknown) => void,
  ) {}

  /**
   * Queues reconciliation runs for imported, enabled mappings whose last pass is older than
   * `intervalMs` (with a 10% margin so a slightly early tick still picks them up).
   */
  async queueDue(
    type: 'RECONCILIATION' | 'DEEP_RECONCILIATION',
    intervalMs: number,
    now: Date,
  ): Promise<ScheduleTotals> {
    const dueBefore = new Date(now.getTime() - intervalMs * 0.9);
    return this.forEachOrganization(async (organizationId) => {
      const mappings = await this.db.jiraProjectMapping.findMany({
        where: {
          organizationId,
          removedAt: null,
          syncEnabled: true,
          importState: 'COMPLETED',
          connection: { status: { in: ['ACTIVE', 'ERROR'] } },
          ...(type === 'RECONCILIATION'
            ? { OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: dueBefore } }] }
            : { OR: [{ lastDeepReconciledAt: null }, { lastDeepReconciledAt: { lt: dueBefore } }] }),
        },
        select: { id: true, connectionId: true },
        orderBy: { id: 'asc' },
      });
      let queued = 0;
      for (const mapping of mappings) {
        if (
          (await queueSyncRun(this.db, organizationId, {
            connectionId: mapping.connectionId,
            mappingId: mapping.id,
            type,
          })) !== null
        ) {
          queued += 1;
        }
      }
      return queued;
    });
  }

  /** Active connections per organization (webhook upkeep). */
  async forEachConnection(fn: (connectionId: string) => Promise<void>): Promise<ScheduleTotals> {
    return this.forEachOrganization(async (organizationId) => {
      const connections = await this.db.jiraConnection.findMany({
        where: { organizationId, status: { in: ['ACTIVE', 'ERROR'] } },
        select: { id: true },
      });
      for (const connection of connections) {
        await fn(connection.id);
      }
      return connections.length;
    });
  }

  /**
   * Watchdog: re-enqueues QUEUED/RUNNING runs that made no progress since `before` (lost job,
   * crashed worker). The run resumes from its persisted checkpoint.
   */
  async requeueStale(before: Date): Promise<number> {
    const stale = await staleJiraRuns(this.prisma, before);
    let requeued = 0;
    for (const { organizationId, runId } of stale) {
      try {
        await this.tenant.run(systemContext(organizationId), () =>
          this.db.$transaction(async (tx) => {
            const touched = await tx.jiraSyncRun.updateMany({
              where: { organizationId, id: runId, status: { in: ['QUEUED', 'RUNNING'] } },
              data: { updatedAt: new Date() },
            });
            if (touched.count > 0) {
              await enqueueRun(tx, organizationId, runId);
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

  private async forEachOrganization(fn: (organizationId: string) => Promise<number>): Promise<ScheduleTotals> {
    const organizations = await organizationsWithJiraConnections(this.prisma);
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
