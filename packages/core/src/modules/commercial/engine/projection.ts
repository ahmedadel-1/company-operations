import type { Prisma } from '@company-ops/db';

import { noticeDeadline } from './dates.js';
import { sumDecimals } from './money.js';

/**
 * Contract projection (ADR-0026, spec §37). The baseline (original value and expiry) is never
 * rewritten; the current values are rebuilt from it plus, in application order:
 * - EFFECTIVE amendments: value deltas add up; a new expiry replaces the current one;
 * - RENEWED/EXTENDED renewal actions: a new expiry replaces the current one.
 * The last applied date change wins. The services rebuild under the contract's version lock, so two
 * concurrent activations cannot both apply on the same base.
 */
export interface ProjectionInput {
  readonly originalValue: Prisma.Decimal;
  readonly originalExpiryDate: string | null;
  readonly noticePeriodDays: number | null;
  readonly amendments: readonly {
    readonly valueDelta: Prisma.Decimal | null;
    readonly newExpiryDate: string | null;
    readonly appliedAt: Date;
  }[];
  readonly renewals: readonly { readonly newExpiryDate: string | null; readonly appliedAt: Date }[];
}

export interface Projection {
  readonly currentValue: Prisma.Decimal;
  readonly currentExpiryDate: string | null;
  readonly renewalNoticeDeadline: string | null;
}

export function projectContract(input: ProjectionInput): Projection {
  const deltas = input.amendments.flatMap((amendment) => (amendment.valueDelta === null ? [] : [amendment.valueDelta]));
  const currentValue = input.originalValue.plus(sumDecimals(deltas));
  const dateChanges = [
    ...input.amendments.map((amendment) => ({ date: amendment.newExpiryDate, at: amendment.appliedAt })),
    ...input.renewals.map((renewal) => ({ date: renewal.newExpiryDate, at: renewal.appliedAt })),
  ]
    .filter((change): change is { date: string; at: Date } => change.date !== null)
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  const currentExpiryDate = dateChanges.at(-1)?.date ?? input.originalExpiryDate;
  return {
    currentValue,
    currentExpiryDate,
    renewalNoticeDeadline: noticeDeadline(currentExpiryDate, input.noticePeriodDays),
  };
}
