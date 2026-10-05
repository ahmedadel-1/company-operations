import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Cross-tenant lookups for the GitHub integration's system processes (Phase 5). Each result only
 * identifies organizations or rows; the work itself then runs inside that organization's tenant
 * context through the guarded client.
 */

/**
 * The binding of a GitHub installation id, by GitHub's id only. Used by the unauthenticated webhook
 * endpoint after the signature check to bind a delivery to its tenant; the payload never chooses
 * the organization.
 */
export async function githubInstallationBinding(
  db: RawSqlClient,
  githubInstallationId: string,
): Promise<{ organizationId: string; installationId: string; status: string } | null> {
  if (!/^[1-9][0-9]{0,18}$/.test(githubInstallationId)) {
    return null;
  }
  const rows = await db.$queryRaw<{ organization_id: string; id: string; status: string }[]>(Prisma.sql`
    SELECT i.organization_id::text AS organization_id, i.id::text AS id, i.status::text AS status
    FROM github_installations i
    JOIN organizations o ON o.id = i.organization_id
    WHERE i.github_installation_id = ${githubInstallationId}::bigint
      AND o.status = 'ACTIVE'
  `);
  const row = rows[0];
  return row === undefined ? null : { organizationId: row.organization_id, installationId: row.id, status: row.status };
}

/** Whether a GitHub installation id is bound to any organization (setup conflict check). */
export async function githubInstallationOwner(db: RawSqlClient, githubInstallationId: string): Promise<string | null> {
  if (!/^[1-9][0-9]{0,18}$/.test(githubInstallationId)) {
    return null;
  }
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT organization_id::text AS organization_id
    FROM github_installations
    WHERE github_installation_id = ${githubInstallationId}::bigint
  `);
  return rows[0]?.organization_id ?? null;
}

/** Active organizations with an ACTIVE or SUSPENDED installation (scheduled refresh and reconciliation). */
export async function organizationsWithGithubInstallations(db: RawSqlClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT DISTINCT i.organization_id::text AS organization_id
    FROM github_installations i
    JOIN organizations o ON o.id = i.organization_id
    WHERE o.status = 'ACTIVE'
      AND i.status IN ('ACTIVE', 'SUSPENDED')
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}

/** Queued or running GitHub sync runs that have not progressed since `before`. */
export async function staleGithubRuns(
  db: RawSqlClient,
  before: Date,
  limit = 100,
): Promise<{ organizationId: string; runId: string }[]> {
  const rows = await db.$queryRaw<{ organization_id: string; id: string }[]>(Prisma.sql`
    SELECT organization_id::text AS organization_id, id::text AS id
    FROM github_sync_runs
    WHERE status IN ('QUEUED', 'RUNNING')
      AND updated_at < ${before}
    ORDER BY updated_at
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ organizationId: row.organization_id, runId: row.id }));
}

/** Active organizations that configured at least one retention policy. */
export async function organizationsWithRetentionPolicies(db: RawSqlClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT DISTINCT p.organization_id::text AS organization_id
    FROM retention_policies p
    JOIN organizations o ON o.id = p.organization_id
    WHERE o.status = 'ACTIVE'
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}

/**
 * Runs the bounded, policy-driven purge (`purge_integration_records`, ADR-0020) for one organization
 * and category. The function itself refuses to delete anything without a policy row.
 */
export async function purgeIntegrationRecords(
  db: RawSqlClient,
  organizationId: string,
  category: 'WEBHOOK_DELIVERIES' | 'SYNC_FAILURES',
  limit: number,
): Promise<number> {
  const rows = await db.$queryRaw<{ purged: number }[]>(Prisma.sql`
    SELECT purge_integration_records(${organizationId}::uuid, ${category}::"RetentionCategory", ${limit}::int) AS purged
  `);
  return rows[0]?.purged ?? 0;
}
