import type { ObligationRecurrence } from '@company-ops/db';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { dateOnly } from './commercial-support.js';
import { planOccurrences } from './engine/recurrence.js';

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * Generates the next occurrences of an obligation up to its horizon (spec §39). Inserts skip
 * existing (obligation, due date) rows, so a repeated or concurrent run never duplicates; returns the
 * number of rows inserted. Cancelled obligations generate nothing.
 */
export async function extendObligation(
  tx: TenantDb,
  organizationId: string,
  obligation: {
    readonly id: string;
    readonly contractId: string;
    readonly recurrence: ObligationRecurrence;
    readonly dueDate: Date;
    readonly recurrenceUntil: Date | null;
    readonly generatedThrough: Date | null;
    readonly ownerMemberId: string | null;
    readonly cancelledAt: Date | null;
  },
  today: string,
): Promise<number> {
  if (obligation.cancelledAt !== null) return 0;
  const plan = planOccurrences({
    anchor: dateOnly(obligation.dueDate) ?? today,
    recurrence: obligation.recurrence,
    until: dateOnly(obligation.recurrenceUntil),
    today,
    after: dateOnly(obligation.generatedThrough),
  });
  let inserted = 0;
  if (plan.dueDates.length > 0) {
    const result = await tx.contractObligationOccurrence.createMany({
      data: plan.dueDates.map((dueDate) => ({
        organizationId,
        obligationId: obligation.id,
        contractId: obligation.contractId,
        dueDate: day(dueDate),
        ownerMemberId: obligation.ownerMemberId,
      })),
      skipDuplicates: true,
    });
    inserted = result.count;
  }
  if (dateOnly(obligation.generatedThrough) !== plan.generatedThrough) {
    await tx.contractObligation.updateMany({
      where: { organizationId, id: obligation.id },
      data: { generatedThrough: day(plan.generatedThrough) },
    });
  }
  return inserted;
}
