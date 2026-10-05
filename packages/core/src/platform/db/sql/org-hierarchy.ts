import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/** Upper bound on reporting-line and department-tree depth; cycles are also rejected on write. */
export const MAX_HIERARCHY_DEPTH = 50;

/**
 * Members in the TEAM reach of `memberId` (SECURITY §2.1): everyone whose profile reports to the
 * member's profile directly or indirectly, plus members of non-archived teams the member leads.
 * Every table access is bound to `organizationId`; composite foreign keys keep the joins inside it.
 * The member itself is not included (SELF is a separate scope).
 */
export async function teamReachMemberIds(
  db: RawSqlClient,
  organizationId: string,
  memberId: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ member_id: string }[]>(Prisma.sql`
    WITH RECURSIVE me AS (
      SELECT id FROM employee_profiles
      WHERE organization_id = ${organizationId}::uuid AND member_id = ${memberId}::uuid
    ),
    reports AS (
      SELECT p.id, p.member_id, 1 AS depth
      FROM employee_profiles p JOIN me ON p.manager_profile_id = me.id
      WHERE p.organization_id = ${organizationId}::uuid
      UNION
      SELECT p.id, p.member_id, r.depth + 1
      FROM employee_profiles p JOIN reports r ON p.manager_profile_id = r.id
      WHERE p.organization_id = ${organizationId}::uuid AND r.depth < ${MAX_HIERARCHY_DEPTH}
    ),
    led AS (
      SELECT p.member_id
      FROM teams t
      JOIN me ON t.lead_profile_id = me.id
      JOIN team_members tm ON tm.organization_id = t.organization_id AND tm.team_id = t.id
      JOIN employee_profiles p ON p.organization_id = tm.organization_id AND p.id = tm.profile_id
      WHERE t.organization_id = ${organizationId}::uuid AND t.archived_at IS NULL
    )
    SELECT member_id::text AS member_id FROM reports
    UNION
    SELECT member_id::text AS member_id FROM led
  `);
  return rows.map((row) => row.member_id).filter((id) => id !== memberId);
}

/**
 * Departments in the DEPARTMENT reach of `memberId`: non-archived departments whose manager is the
 * member's profile, plus all their descendants.
 */
export async function departmentReachIds(
  db: RawSqlClient,
  organizationId: string,
  memberId: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    WITH RECURSIVE me AS (
      SELECT id FROM employee_profiles
      WHERE organization_id = ${organizationId}::uuid AND member_id = ${memberId}::uuid
    ),
    managed AS (
      SELECT d.id, 1 AS depth
      FROM departments d JOIN me ON d.manager_profile_id = me.id
      WHERE d.organization_id = ${organizationId}::uuid AND d.archived_at IS NULL
      UNION
      SELECT c.id, m.depth + 1
      FROM departments c JOIN managed m ON c.parent_department_id = m.id
      WHERE c.organization_id = ${organizationId}::uuid AND m.depth < ${MAX_HIERARCHY_DEPTH}
    )
    SELECT DISTINCT id::text AS id FROM managed
  `);
  return rows.map((row) => row.id);
}

/**
 * True when `candidateProfileId` is `rootProfileId` or reports to it (directly or indirectly).
 * Used to reject manager assignments that would create a reporting cycle.
 */
export async function isInReportingSubtree(
  db: RawSqlClient,
  organizationId: string,
  rootProfileId: string,
  candidateProfileId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ found: boolean }[]>(Prisma.sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 0 AS depth FROM employee_profiles
      WHERE organization_id = ${organizationId}::uuid AND id = ${rootProfileId}::uuid
      UNION
      SELECT p.id, s.depth + 1
      FROM employee_profiles p JOIN subtree s ON p.manager_profile_id = s.id
      WHERE p.organization_id = ${organizationId}::uuid AND s.depth < ${MAX_HIERARCHY_DEPTH}
    )
    SELECT EXISTS (SELECT 1 FROM subtree WHERE id = ${candidateProfileId}::uuid) AS found
  `);
  return rows[0]?.found === true;
}

/** True when `candidateDepartmentId` is `rootDepartmentId` or one of its descendants. */
export async function isInDepartmentSubtree(
  db: RawSqlClient,
  organizationId: string,
  rootDepartmentId: string,
  candidateDepartmentId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<{ found: boolean }[]>(Prisma.sql`
    WITH RECURSIVE subtree AS (
      SELECT id, 0 AS depth FROM departments
      WHERE organization_id = ${organizationId}::uuid AND id = ${rootDepartmentId}::uuid
      UNION
      SELECT d.id, s.depth + 1
      FROM departments d JOIN subtree s ON d.parent_department_id = s.id
      WHERE d.organization_id = ${organizationId}::uuid AND s.depth < ${MAX_HIERARCHY_DEPTH}
    )
    SELECT EXISTS (SELECT 1 FROM subtree WHERE id = ${candidateDepartmentId}::uuid) AS found
  `);
  return rows[0]?.found === true;
}
