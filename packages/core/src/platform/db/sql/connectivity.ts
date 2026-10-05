import type { PrismaClient } from '@company-ops/db';

/** Readiness probe: proves the database accepts queries. Touches no tenant data. */
export async function pingDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}
