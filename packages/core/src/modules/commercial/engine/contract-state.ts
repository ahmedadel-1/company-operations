import type { ContractRenewalType, ContractStatus, RenewalActionType } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

/**
 * Contract lifecycle (ADR-0026). EXPIRING is derived (ACTIVE or RENEWAL_REVIEW with the current
 * expiry inside the 90-day window) and RENEWED is a renewal action (RENEWED/EXTENDED) that moves the
 * current expiry through the projection and returns the contract to ACTIVE; neither is stored as a
 * status. ACTIVE/RENEWAL_REVIEW contracts whose current expiry has passed are moved to EXPIRED by the
 * commercial monitor (system event). CLOSED is terminal; a contract is never deleted.
 */
export const CONTRACT_STATUSES: readonly ContractStatus[] = [
  'DRAFT',
  'UNDER_REVIEW',
  'AWAITING_SIGNATURE',
  'ACTIVE',
  'RENEWAL_REVIEW',
  'SUSPENDED',
  'EXPIRED',
  'TERMINATED',
  'CLOSED',
];

/** In force: counted as active, monitored for expiry, obligations and guarantees. */
export const LIVE_CONTRACT_STATUSES: readonly ContractStatus[] = ['ACTIVE', 'RENEWAL_REVIEW'];
/** Statuses in which contract health is evaluated. */
export const MONITORED_CONTRACT_STATUSES: readonly ContractStatus[] = [
  'ACTIVE',
  'RENEWAL_REVIEW',
  'SUSPENDED',
  'EXPIRED',
];
export const CLOSED_CONTRACT_STATUSES: readonly ContractStatus[] = ['TERMINATED', 'CLOSED'];

const TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  DRAFT: ['UNDER_REVIEW', 'CLOSED'],
  UNDER_REVIEW: ['DRAFT', 'AWAITING_SIGNATURE', 'CLOSED'],
  AWAITING_SIGNATURE: ['UNDER_REVIEW', 'ACTIVE', 'CLOSED'],
  ACTIVE: ['RENEWAL_REVIEW', 'SUSPENDED', 'EXPIRED', 'TERMINATED', 'CLOSED'],
  RENEWAL_REVIEW: ['ACTIVE', 'EXPIRED', 'TERMINATED'],
  SUSPENDED: ['ACTIVE', 'TERMINATED'],
  EXPIRED: ['CLOSED'],
  TERMINATED: ['CLOSED'],
  CLOSED: [],
};

export type ContractTransitionCheck =
  { readonly ok: true; readonly permission: PermissionKey; readonly needsReason: boolean } | { readonly ok: false };

export function checkContractTransition(from: ContractStatus, to: ContractStatus): ContractTransitionCheck {
  if (!TRANSITIONS[from].includes(to)) return { ok: false };
  const approval =
    (from === 'UNDER_REVIEW' && to === 'AWAITING_SIGNATURE') || (from === 'AWAITING_SIGNATURE' && to === 'ACTIVE');
  const needsReason =
    to === 'SUSPENDED' ||
    to === 'TERMINATED' ||
    (to === 'CLOSED' && from !== 'EXPIRED' && from !== 'TERMINATED') ||
    to === 'DRAFT';
  return { ok: true, permission: approval ? 'contract.approve' : 'contract.edit', needsReason };
}

export function contractTargets(from: ContractStatus): readonly ContractStatus[] {
  return TRANSITIONS[from];
}

/** Baseline fields (currency, original value, original expiry, source tender) change only in DRAFT. */
export function baselineEditable(status: ContractStatus): boolean {
  return status === 'DRAFT';
}

/** Renewal types for which a RENEW / DO_NOT_RENEW decision is expected before expiry. */
export function renewalDecisionExpected(type: ContractRenewalType): boolean {
  return type === 'MANUAL_RENEWAL' || type === 'AUTO_RENEWAL';
}

export function isRenewalDecision(action: RenewalActionType): action is 'RENEW' | 'DO_NOT_RENEW' {
  return action === 'RENEW' || action === 'DO_NOT_RENEW';
}

/** Renewal actions that start a new term (move the current expiry through the projection). */
export function startsNewTerm(action: RenewalActionType): action is 'RENEWED' | 'EXTENDED' {
  return action === 'RENEWED' || action === 'EXTENDED';
}

/** Statuses in which renewal actions may be recorded. */
export function renewalActionAllowed(status: ContractStatus): boolean {
  return status === 'ACTIVE' || status === 'RENEWAL_REVIEW' || status === 'EXPIRED' || status === 'SUSPENDED';
}

/** Status after a renewal action (REVIEW_STARTED opens the review; a new term reactivates). */
export function statusAfterRenewalAction(
  status: ContractStatus,
  action: RenewalActionType,
  newExpiry: string | null,
  today: string,
): ContractStatus {
  if (action === 'REVIEW_STARTED' && status === 'ACTIVE') return 'RENEWAL_REVIEW';
  if (
    startsNewTerm(action) &&
    newExpiry !== null &&
    newExpiry >= today &&
    (status === 'RENEWAL_REVIEW' || status === 'EXPIRED')
  ) {
    return 'ACTIVE';
  }
  return status;
}

/** Display key: `CTR-<year>-<0000>`. */
export function contractKey(year: number, number: number): string {
  return `CTR-${String(year)}-${String(number).padStart(4, '0')}`;
}

export function amendmentKey(contractYear: number, contractNumber: number, amendmentNumber: number): string {
  return `${contractKey(contractYear, contractNumber)}-A${String(amendmentNumber).padStart(2, '0')}`;
}
