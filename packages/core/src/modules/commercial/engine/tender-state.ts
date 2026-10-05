import type { TenderStatus } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

/**
 * Tender lifecycle (ADR-0026). Pure; the tender services are the only writers of `status`.
 *
 * Manual transitions go through `POST /tenders/:id/transitions`; the others happen only inside their
 * controlled operation, which checks its own prerequisites:
 * - BID_DECISION_PENDING/NEW/UNDER_REVIEW/NO_BID/PREPARING -> PREPARING or NO_BID: bid decision;
 * - PREPARING -> INTERNAL_REVIEW: review request (mandatory requirements complete);
 * - INTERNAL_REVIEW -> READY_FOR_SUBMISSION: FINAL gate approved and readiness still complete;
 * - INTERNAL_REVIEW -> PREPARING: a gate returned CHANGES_REQUIRED or REJECTED;
 * - READY_FOR_SUBMISSION -> SUBMITTED: submission (Idempotency-Key);
 * - SUBMITTED/CLARIFICATION -> AWARDED or LOST: award or loss recording.
 * ARCHIVED is terminal; AWARDED, LOST, NO_BID and CANCELLED only move to ARCHIVED (NO_BID can also
 * be re-decided as BID, which is recorded as a new decision, never an overwrite).
 */
export const TENDER_STATUSES: readonly TenderStatus[] = [
  'DRAFT',
  'NEW',
  'UNDER_REVIEW',
  'BID_DECISION_PENDING',
  'NO_BID',
  'PREPARING',
  'INTERNAL_REVIEW',
  'READY_FOR_SUBMISSION',
  'SUBMITTED',
  'CLARIFICATION',
  'AWARDED',
  'LOST',
  'CANCELLED',
  'ARCHIVED',
];

/** Statuses of a live opportunity (dashboard "active", deadline reminders, readiness alerts). */
export const ACTIVE_TENDER_STATUSES: readonly TenderStatus[] = [
  'NEW',
  'UNDER_REVIEW',
  'BID_DECISION_PENDING',
  'PREPARING',
  'INTERNAL_REVIEW',
  'READY_FOR_SUBMISSION',
];

/** Statuses before submission in which the bid is still being prepared (readiness matters). */
export const PREPARATION_STATUSES: readonly TenderStatus[] = ['PREPARING', 'INTERNAL_REVIEW', 'READY_FOR_SUBMISSION'];

/** Statuses in which the bid/no-bid decision may be (re)recorded. */
export const BID_DECISION_STATUSES: readonly TenderStatus[] = [
  'NEW',
  'UNDER_REVIEW',
  'BID_DECISION_PENDING',
  'NO_BID',
  'PREPARING',
];

/** Statuses after submission (submission fields are immutable through normal edit). */
export const SUBMITTED_STATUSES: readonly TenderStatus[] = ['SUBMITTED', 'CLARIFICATION', 'AWARDED', 'LOST'];

/** Closed for work: no requirement, document or review changes. */
export const CLOSED_TENDER_STATUSES: readonly TenderStatus[] = ['NO_BID', 'AWARDED', 'LOST', 'CANCELLED', 'ARCHIVED'];

const MANUAL: Readonly<Record<TenderStatus, readonly TenderStatus[]>> = {
  DRAFT: ['NEW', 'CANCELLED'],
  NEW: ['UNDER_REVIEW', 'BID_DECISION_PENDING', 'CANCELLED'],
  UNDER_REVIEW: ['BID_DECISION_PENDING', 'CANCELLED'],
  BID_DECISION_PENDING: ['CANCELLED'],
  NO_BID: ['ARCHIVED'],
  PREPARING: ['CANCELLED'],
  INTERNAL_REVIEW: ['PREPARING', 'CANCELLED'],
  READY_FOR_SUBMISSION: ['PREPARING', 'CANCELLED'],
  SUBMITTED: ['CLARIFICATION', 'CANCELLED'],
  CLARIFICATION: ['SUBMITTED', 'CANCELLED'],
  AWARDED: ['ARCHIVED'],
  LOST: ['ARCHIVED'],
  CANCELLED: ['ARCHIVED'],
  ARCHIVED: [],
};

export type TenderTransitionCheck =
  | { readonly ok: true; readonly permission: PermissionKey; readonly needsReason: boolean }
  | { readonly ok: false; readonly reason: 'NOT_ALLOWED' | 'CONTROLLED' };

/** Targets only reachable through their controlled operation (never through the generic endpoint). */
const CONTROLLED: readonly TenderStatus[] = ['NO_BID', 'INTERNAL_REVIEW', 'READY_FOR_SUBMISSION', 'AWARDED', 'LOST'];

/** Whether `from -> to` is a manual transition, and the permission it needs on the tender. */
export function checkManualTransition(from: TenderStatus, to: TenderStatus): TenderTransitionCheck {
  if (MANUAL[from].includes(to)) {
    return { ok: true, permission: 'tender.edit', needsReason: to === 'CANCELLED' };
  }
  if (CONTROLLED.includes(to) || (to === 'PREPARING' && BID_DECISION_STATUSES.includes(from))) {
    return { ok: false, reason: 'CONTROLLED' };
  }
  if (to === 'SUBMITTED' && from === 'READY_FOR_SUBMISSION') {
    return { ok: false, reason: 'CONTROLLED' };
  }
  return { ok: false, reason: 'NOT_ALLOWED' };
}

export function manualTargets(from: TenderStatus): readonly TenderStatus[] {
  return MANUAL[from];
}

/** The status a recorded bid decision moves the tender to. */
export function statusAfterBidDecision(decision: 'BID' | 'NO_BID'): TenderStatus {
  return decision === 'BID' ? 'PREPARING' : 'NO_BID';
}

/** Draft-only hard delete (the database refuses any other delete as well). */
export function isDeletable(status: TenderStatus): boolean {
  return status === 'DRAFT';
}

/** Work on requirements, documents, addenda and clarifications is allowed. */
export function isOpenForWork(status: TenderStatus): boolean {
  return !CLOSED_TENDER_STATUSES.includes(status);
}

/** Deadlines and submission-critical fields change through normal edit only before work starts. */
export function deadlineEditableDirectly(status: TenderStatus): boolean {
  return status === 'DRAFT' || status === 'NEW';
}

/** Display key: `TND-<year>-<0000>` (the number is organization-wide, not reset yearly). */
export function tenderKey(year: number, number: number): string {
  return `TND-${String(year)}-${String(number).padStart(4, '0')}`;
}
