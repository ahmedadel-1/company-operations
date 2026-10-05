import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Organizations with at least one project that currently requires daily reports. The missing-report
 * check is a system process that spans organizations; each organization is then checked inside its
 * own tenant context.
 */
export async function organizationsRequiringDailyReports(db: RawSqlClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT DISTINCT p.organization_id::text AS organization_id
    FROM projects p
    JOIN organizations o ON o.id = p.organization_id
    WHERE o.status = 'ACTIVE'
      AND p.status IN ('ACTIVE', 'MAINTENANCE')
      AND p.daily_report_policy -> 'required' = 'true'::jsonb
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}
