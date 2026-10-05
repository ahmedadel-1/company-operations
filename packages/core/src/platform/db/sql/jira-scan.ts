import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Cross-tenant lookups for the Jira integration's system processes (Phase 4). Each result only
 * identifies organizations or rows; the work itself then runs inside that organization's tenant
 * context through the guarded client.
 */

/** Active organizations with a usable (ACTIVE or ERROR) Jira connection. */
export async function organizationsWithJiraConnections(db: RawSqlClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT DISTINCT c.organization_id::text AS organization_id
    FROM jira_connections c
    JOIN organizations o ON o.id = c.organization_id
    WHERE o.status = 'ACTIVE'
      AND c.status IN ('ACTIVE', 'ERROR')
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}

/** Queued or running sync runs that have not progressed since `before` (lost jobs, crashed workers). */
export async function staleJiraRuns(
  db: RawSqlClient,
  before: Date,
  limit = 100,
): Promise<{ organizationId: string; runId: string }[]> {
  const rows = await db.$queryRaw<{ organization_id: string; id: string }[]>(Prisma.sql`
    SELECT organization_id::text AS organization_id, id::text AS id
    FROM jira_sync_runs
    WHERE status IN ('QUEUED', 'RUNNING')
      AND updated_at < ${before}
    ORDER BY updated_at
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ organizationId: row.organization_id, runId: row.id }));
}

/**
 * The organization and state of a connection, by id only. Used by the unauthenticated webhook
 * endpoint after the signature check, to bind the delivery to its tenant.
 */
export async function jiraConnectionTenant(
  db: RawSqlClient,
  connectionId: string,
): Promise<{ organizationId: string; status: string } | null> {
  const rows = await db.$queryRaw<{ organization_id: string; status: string }[]>(Prisma.sql`
    SELECT c.organization_id::text AS organization_id, c.status::text AS status
    FROM jira_connections c
    JOIN organizations o ON o.id = c.organization_id
    WHERE c.id = ${connectionId}::uuid
      AND o.status = 'ACTIVE'
  `);
  const row = rows[0];
  return row === undefined ? null : { organizationId: row.organization_id, status: row.status };
}
