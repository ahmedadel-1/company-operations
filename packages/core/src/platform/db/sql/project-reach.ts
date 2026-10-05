import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Projects in the PROJECT reach of `memberId` (SECURITY §2.1): projects where the member's employee
 * profile is a project member, the project manager or the technical manager. Archived projects are
 * included (their history stays readable; writes are blocked by the project lifecycle). Every table
 * access is bound to `organizationId`; composite foreign keys keep the joins inside it.
 */
export async function projectReachIds(db: RawSqlClient, organizationId: string, memberId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH me AS (
      SELECT id FROM employee_profiles
      WHERE organization_id = ${organizationId}::uuid AND member_id = ${memberId}::uuid
    )
    SELECT pm.project_id::text AS id
    FROM project_members pm JOIN me ON pm.profile_id = me.id
    WHERE pm.organization_id = ${organizationId}::uuid
    UNION
    SELECT p.id::text AS id
    FROM projects p JOIN me ON p.project_manager_profile_id = me.id
    WHERE p.organization_id = ${organizationId}::uuid
    UNION
    SELECT p.id::text AS id
    FROM projects p JOIN me ON p.technical_manager_profile_id = me.id
    WHERE p.organization_id = ${organizationId}::uuid
  `);
  return rows.map((row) => row.id);
}
