import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Serializes administrator-changing operations of one organization (grant/revoke of admin roles,
 * member disable) for the rest of the transaction, so two concurrent revocations cannot both pass
 * the "last administrator" check. Locks the organization's own row only.
 */
export async function lockOrganizationForAdminChange(db: RawSqlClient, organizationId: string): Promise<void> {
  await db.$queryRaw(Prisma.sql`
    SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE
  `);
}

/**
 * Serializes reporting-line and department-tree changes of one organization for the rest of the
 * transaction (transaction-scoped advisory lock), so two concurrent edits cannot each pass the
 * cycle check and together create a cycle.
 */
export async function lockOrganizationHierarchy(db: RawSqlClient, organizationId: string): Promise<void> {
  // pg_advisory_xact_lock returns void, which the query engine cannot deserialize.
  await db.$queryRaw(Prisma.sql`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`hierarchy:${organizationId}`}, 0))
  `);
}

/**
 * Serializes approval-delegation changes of one organization for the rest of the transaction, so two
 * concurrent creations cannot each pass the overlap and reverse-delegation checks (ADR-0021).
 */
export async function lockApprovalDelegations(db: RawSqlClient, organizationId: string): Promise<void> {
  await db.$queryRaw(Prisma.sql`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`delegations:${organizationId}`}, 0))
  `);
}

/**
 * Serializes changes to the children of one commercial aggregate (a tender's requirements, a
 * contract's projection inputs) for the rest of the transaction, so counters and projections
 * recomputed from those children never interleave (ADR-0026).
 */
export async function lockCommercialAggregate(
  db: RawSqlClient,
  organizationId: string,
  aggregate: 'tender' | 'contract',
  aggregateId: string,
): Promise<void> {
  await db.$queryRaw(Prisma.sql`
    SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`${aggregate}:${organizationId}:${aggregateId}`}, 0))
  `);
}
