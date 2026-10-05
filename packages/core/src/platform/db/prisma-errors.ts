import { Prisma } from '@company-ops/db';

/** Unique constraint violation (P2002), e.g. a duplicate department code. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Exclusion constraint violation (SQLSTATE 23P01), e.g. overlapping shift assignments. The driver adapter
 * surfaces it without a dedicated Prisma code, so the SQLSTATE or constraint wording is matched.
 */
export function isExclusionViolation(error: unknown): boolean {
  return error instanceof Error && /23P01|exclusion constraint/i.test(`${error.message} ${JSON.stringify(error)}`);
}

/** Foreign key violation (P2003): a referenced row does not exist in the same organization. */
export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}
