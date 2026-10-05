import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Serializes attendance changes of one employee for the rest of the transaction (transaction-scoped
 * advisory lock): concurrent check-ins, check-outs, corrections and effect materialization for the
 * same person run one after another, so double taps never create two check-ins and a derived record
 * is always recomputed from the complete event log.
 */
export async function lockAttendanceProfile(
  db: RawSqlClient,
  organizationId: string,
  profileId: string,
): Promise<void> {
  await db.$queryRaw(Prisma.sql`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`attendance:${organizationId}:${profileId}`}, 0))
  `);
}

/** Serializes on-demand provisioning of the reserved attendance correction request type per organization. */
export async function lockCorrectionTypeProvisioning(db: RawSqlClient, organizationId: string): Promise<void> {
  await db.$queryRaw(Prisma.sql`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`attendance-correction-type:${organizationId}`}, 0))
  `);
}

/**
 * Active organizations with attendance records that may need the missing-checkout sweep: OPEN records
 * (or SCHEDULED records of past days) whose work date is on or before `latestWorkDate`. Identifiers only;
 * each organization is then processed in its own tenant context.
 */
export async function organizationsWithOpenAttendance(db: RawSqlClient, latestWorkDate: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ organization_id: string }[]>(Prisma.sql`
    SELECT DISTINCT r.organization_id::text AS organization_id
    FROM attendance_records r
    JOIN organizations o ON o.id = r.organization_id
    WHERE o.status = 'ACTIVE'
      AND r.status IN ('OPEN', 'SCHEDULED')
      AND r.work_date <= ${latestWorkDate}::date
    ORDER BY 1
  `);
  return rows.map((row) => row.organization_id);
}

/**
 * Runs the bounded, policy-driven coordinate retention (`purge_attendance_coordinates`, ADR-0022) for one
 * organization. The function refuses to change anything without an ATTENDANCE_COORDINATES policy row.
 */
export async function purgeAttendanceCoordinates(
  db: RawSqlClient,
  organizationId: string,
  limit: number,
): Promise<number> {
  const rows = await db.$queryRaw<{ purged: number }[]>(Prisma.sql`
    SELECT purge_attendance_coordinates(${organizationId}::uuid, ${limit}::int) AS purged
  `);
  return rows[0]?.purged ?? 0;
}
