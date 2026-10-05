import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Attachments whose upload window passed without completion. Maintenance is a system process and
 * scans all organizations; each returned row carries its organization, and the cleanup then runs
 * per row inside that organization's tenant context.
 */
export async function expiredPendingAttachments(
  db: RawSqlClient,
  limit: number,
): Promise<{ id: string; organizationId: string }[]> {
  const rows = await db.$queryRaw<{ id: string; organization_id: string }[]>(Prisma.sql`
    SELECT id::text AS id, organization_id::text AS organization_id
    FROM attachments
    WHERE status = 'PENDING_UPLOAD' AND upload_expires_at < now()
    ORDER BY upload_expires_at
    LIMIT ${limit}
  `);
  return rows.map((row) => ({ id: row.id, organizationId: row.organization_id }));
}
