import type { ObligationRecurrence } from '@company-ops/db';

import { addDays } from '../../projects/business-date.js';

/**
 * Bounded obligation recurrence (ADR-0026): NONE, MONTHLY, QUARTERLY, YEARLY from the first due date,
 * keeping its day of month and clamping to the month end (31 Jan -> 28/29 Feb -> 31 Mar; 29 Feb ->
 * 28 Feb in common years). No free-form rules. Occurrences are generated up to a rolling horizon and
 * are unique per (obligation, due date), so regeneration is idempotent.
 */
export const RECURRENCE_HORIZON_DAYS = 90;
/** Upper bound of rows one generation pass may produce for one obligation. */
export const MAX_OCCURRENCES_PER_PASS = 24;

const MONTH_STEP: Readonly<Record<Exclude<ObligationRecurrence, 'NONE'>, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  YEARLY: 12,
};

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** The `index`-th due date of a series anchored at `anchor` (index 0 = the anchor itself). */
export function nthDueDate(anchor: string, recurrence: ObligationRecurrence, index: number): string {
  if (recurrence === 'NONE' || index === 0) return anchor;
  const [year = 0, month = 1, day = 1] = anchor.split('-').map(Number);
  const totalMonths = month - 1 + MONTH_STEP[recurrence] * index;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = totalMonths % 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

export interface GenerationPlan {
  /** Due dates to insert (existing ones are skipped by the unique key). */
  readonly dueDates: readonly string[];
  /** New `generated_through` (the horizon end, capped at `until`). */
  readonly generatedThrough: string;
}

/**
 * Due dates of a series from `anchor` up to min(`until`, `today` + horizon), always including the
 * anchor. `after` (the previous `generated_through`) skips dates already planned.
 */
export function planOccurrences(input: {
  readonly anchor: string;
  readonly recurrence: ObligationRecurrence;
  readonly until: string | null;
  readonly today: string;
  readonly after: string | null;
}): GenerationPlan {
  if (input.recurrence === 'NONE') {
    return { dueDates: input.after === null ? [input.anchor] : [], generatedThrough: input.anchor };
  }
  const horizon = addDays(input.today > input.anchor ? input.today : input.anchor, RECURRENCE_HORIZON_DAYS);
  const end = input.until !== null && input.until < horizon ? input.until : horizon;
  const dueDates: string[] = [];
  for (let index = 0; dueDates.length < MAX_OCCURRENCES_PER_PASS; index += 1) {
    const due = nthDueDate(input.anchor, input.recurrence, index);
    if (due > end) break;
    if (input.after === null || due > input.after) dueDates.push(due);
  }
  const last = dueDates.at(-1);
  const generatedThrough = dueDates.length === MAX_OCCURRENCES_PER_PASS && last !== undefined ? last : end;
  return { dueDates, generatedThrough };
}
