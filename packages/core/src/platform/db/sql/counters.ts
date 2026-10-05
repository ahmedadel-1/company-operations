import { Prisma } from '@company-ops/db';

import type { RawSqlClient } from './raw-sql-client.js';

/**
 * Atomically increments and returns the organization's counter `key` (DATA_MODEL §3). Concurrent
 * callers serialize on the row; inside a transaction the number is released only on commit.
 */
export async function nextCounterValue(db: RawSqlClient, organizationId: string, key: string): Promise<bigint> {
  const rows = await db.$queryRaw<{ value: bigint }[]>(Prisma.sql`
    INSERT INTO organization_counters (organization_id, key, value)
    VALUES (${organizationId}::uuid, ${key}, 1)
    ON CONFLICT (organization_id, key)
    DO UPDATE SET value = organization_counters.value + 1
    RETURNING value
  `);
  const value = rows[0]?.value;
  if (value === undefined) {
    throw new Error(`Counter ${key} did not return a value.`);
  }
  return value;
}
