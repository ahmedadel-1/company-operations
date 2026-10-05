import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Active organizations with at least one open support ticket. The SLA sweep is a system process
 * that spans organizations; each organization is then evaluated inside its own tenant context.
 * The status predicate matches the partial index `support_tickets_open_resolution_due_idx`.
 */
export async function organizationsWithOpenTickets(db: RawSqlClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT o.id::text AS organization_id
    FROM organizations o
    WHERE o.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM support_tickets t
        WHERE t.organization_id = o.id
          AND t.status NOT IN ('RESOLVED', 'VERIFIED', 'CLOSED', 'CANCELLED')
      )
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}

/**
 * Active organizations with at least one overdue, not yet reminded pending approval (the approval
 * reminder sweep, evaluated per organization in its own tenant context). Matches the partial index
 * `request_approvals_due_idx`.
 */
export async function organizationsWithOverdueApprovals(db: RawSqlClient, now: Date): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT o.id::text AS organization_id
    FROM organizations o
    WHERE o.status = 'ACTIVE'
      AND EXISTS (
        SELECT 1 FROM request_approvals a
        WHERE a.organization_id = o.id
          AND a.status = 'PENDING' AND a.reminded_at IS NULL AND a.due_at IS NOT NULL
          AND a.due_at <= ${now}
      )
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}
