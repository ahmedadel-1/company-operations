import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Active organizations holding any commercial record (tender, contract, corporate document or
 * guarantee). The commercial monitor is a system process spanning organizations; each one is then
 * evaluated inside its own tenant context.
 */
export async function organizationsWithCommercialRecords(db: RawSqlClient): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT o.id::text AS organization_id
    FROM organizations o
    WHERE o.status = 'ACTIVE'
      AND (
        EXISTS (SELECT 1 FROM tenders t WHERE t.organization_id = o.id)
        OR EXISTS (SELECT 1 FROM contracts c WHERE c.organization_id = o.id)
        OR EXISTS (SELECT 1 FROM corporate_documents d WHERE d.organization_id = o.id)
        OR EXISTS (SELECT 1 FROM guarantees g WHERE g.organization_id = o.id)
      )
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}
