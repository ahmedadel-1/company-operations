import type { Prisma } from '@company-ops/db';

/**
 * The part of a Prisma client (base, tenant-scoped or transaction) that tagged SQL in this folder
 * uses. Statements are built with `Prisma.sql`, so every value is a bound parameter.
 */
export interface RawSqlClient {
  $queryRaw<T = unknown>(query: Prisma.Sql): PromiseLike<T>;
  $executeRaw(query: Prisma.Sql): PromiseLike<number>;
}
