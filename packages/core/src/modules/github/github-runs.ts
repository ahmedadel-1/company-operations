import type { GithubSyncRunType } from '@company-ops/db';

import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';

export async function enqueueGithubRun(db: TenantDb, organizationId: string, runId: string): Promise<void> {
  await enqueueOutboxEvent(db, organizationId, {
    eventType: 'github.sync.requested',
    aggregateType: 'github_sync_run',
    aggregateId: runId,
    payload: { runId },
  });
}

export async function enqueueInstallationSync(
  db: TenantDb,
  organizationId: string,
  installationId: string,
): Promise<void> {
  await enqueueOutboxEvent(db, organizationId, {
    eventType: 'github.installation.sync',
    aggregateType: 'github_installation',
    aggregateId: installationId,
    payload: { installationId },
  });
}

/**
 * Creates a QUEUED run and its outbox event in one transaction. Null when the repository already
 * has an active run (partial unique index).
 */
export async function queueGithubRun(
  db: TenantScopedClient,
  organizationId: string,
  input: {
    installationId: string;
    repositoryId: string;
    type: GithubSyncRunType;
    requestedByMemberId?: string | null;
    requestId?: string | null;
  },
): Promise<string | null> {
  try {
    return await db.$transaction(async (tx) => {
      const run = await tx.githubSyncRun.create({
        data: {
          organizationId,
          installationId: input.installationId,
          repositoryId: input.repositoryId,
          type: input.type,
          requestedByMemberId: input.requestedByMemberId ?? null,
          requestId: input.requestId ?? null,
        },
        select: { id: true },
      });
      await enqueueGithubRun(tx, organizationId, run.id);
      return run.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
}

/** Asks active runs of the given repositories (or installation) to stop at their next page. */
export async function cancelGithubRuns(
  db: TenantDb,
  organizationId: string,
  where: { installationId: string } | { repositoryId: string },
): Promise<void> {
  await db.githubSyncRun.updateMany({
    where: { organizationId, ...where, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { cancelRequested: true },
  });
}
