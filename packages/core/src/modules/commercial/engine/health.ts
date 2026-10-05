import type { CommercialHealth, ContractRenewalType, ContractStatus } from '@company-ops/db';

import { daysBetween } from '../../projects/business-date.js';
import { MONITORED_CONTRACT_STATUSES, renewalDecisionExpected } from './contract-state.js';
import { CONTRACT_EXPIRING_DAYS, NOTICE_APPROACHING_DAYS } from './dates.js';

/**
 * Contract health (ADR-0026, spec §45): deterministic, explainable, no scoring. Every reason has a
 * fixed severity; the health is the most severe reason (HEALTHY without reasons). One calculation,
 * stored on the contract and refreshed in the transaction of every relevant change and daily by the
 * commercial monitor; detail, list, dashboard and needs-attention all read the stored result.
 */
export type ContractHealthReason =
  | 'EXPIRY_APPROACHING'
  | 'EXPIRED_WITHOUT_DECISION'
  | 'RENEWAL_DECISION_OVERDUE'
  | 'NOTICE_DEADLINE_APPROACHING'
  | 'NOTICE_DEADLINE_PASSED'
  | 'OBLIGATION_OVERDUE'
  | 'CRITICAL_OBLIGATION_OVERDUE'
  | 'MILESTONE_OVERDUE'
  | 'GUARANTEE_EXPIRING'
  | 'GUARANTEE_EXPIRED'
  | 'SIGNED_CONTRACT_MISSING'
  | 'AMENDMENT_AWAITING_APPROVAL';

export const HEALTH_REASON_SEVERITY: Readonly<Record<ContractHealthReason, CommercialHealth>> = {
  EXPIRY_APPROACHING: 'NEEDS_ATTENTION',
  EXPIRED_WITHOUT_DECISION: 'CRITICAL',
  RENEWAL_DECISION_OVERDUE: 'AT_RISK',
  NOTICE_DEADLINE_APPROACHING: 'AT_RISK',
  NOTICE_DEADLINE_PASSED: 'CRITICAL',
  OBLIGATION_OVERDUE: 'NEEDS_ATTENTION',
  CRITICAL_OBLIGATION_OVERDUE: 'CRITICAL',
  MILESTONE_OVERDUE: 'AT_RISK',
  GUARANTEE_EXPIRING: 'NEEDS_ATTENTION',
  GUARANTEE_EXPIRED: 'AT_RISK',
  SIGNED_CONTRACT_MISSING: 'NEEDS_ATTENTION',
  AMENDMENT_AWAITING_APPROVAL: 'NEEDS_ATTENTION',
};

const RANK: Readonly<Record<CommercialHealth, number>> = { HEALTHY: 0, NEEDS_ATTENTION: 1, AT_RISK: 2, CRITICAL: 3 };

export interface HealthFacts {
  readonly status: ContractStatus;
  readonly renewalType: ContractRenewalType;
  readonly currentExpiryDate: string | null;
  readonly renewalDecisionDate: string | null;
  readonly renewalNoticeDeadline: string | null;
  /** RENEW / DO_NOT_RENEW recorded for the current term. */
  readonly renewalDecided: boolean;
  readonly overdueObligations: number;
  readonly overdueCriticalObligations: number;
  readonly overdueMilestones: number;
  readonly expiringGuarantees: number;
  readonly expiredGuarantees: number;
  readonly hasSignedContract: boolean;
  readonly amendmentsUnderReview: number;
}

export interface HealthResult {
  readonly health: CommercialHealth;
  readonly reasons: readonly ContractHealthReason[];
}

export function evaluateHealth(facts: HealthFacts, today: string): HealthResult {
  if (!MONITORED_CONTRACT_STATUSES.includes(facts.status)) {
    return { health: 'HEALTHY', reasons: [] };
  }
  const reasons: ContractHealthReason[] = [];
  const decisionPending = renewalDecisionExpected(facts.renewalType) && !facts.renewalDecided;
  const expiry = facts.currentExpiryDate;
  const expired = facts.status === 'EXPIRED' || (expiry !== null && expiry < today);

  if (expired) {
    if (decisionPending) reasons.push('EXPIRED_WITHOUT_DECISION');
  } else {
    if (expiry !== null && facts.renewalType !== 'EVERGREEN' && daysBetween(today, expiry) <= CONTRACT_EXPIRING_DAYS) {
      reasons.push('EXPIRY_APPROACHING');
    }
    if (decisionPending && facts.renewalDecisionDate !== null && facts.renewalDecisionDate < today) {
      reasons.push('RENEWAL_DECISION_OVERDUE');
    }
    const notice = facts.renewalNoticeDeadline;
    if (decisionPending && notice !== null) {
      if (notice < today) reasons.push('NOTICE_DEADLINE_PASSED');
      else if (daysBetween(today, notice) <= NOTICE_APPROACHING_DAYS) reasons.push('NOTICE_DEADLINE_APPROACHING');
    }
  }
  if (facts.overdueCriticalObligations > 0) reasons.push('CRITICAL_OBLIGATION_OVERDUE');
  if (facts.overdueObligations > facts.overdueCriticalObligations) reasons.push('OBLIGATION_OVERDUE');
  if (facts.overdueMilestones > 0) reasons.push('MILESTONE_OVERDUE');
  if (facts.expiredGuarantees > 0) reasons.push('GUARANTEE_EXPIRED');
  if (facts.expiringGuarantees > 0) reasons.push('GUARANTEE_EXPIRING');
  if (!facts.hasSignedContract && facts.status !== 'EXPIRED') reasons.push('SIGNED_CONTRACT_MISSING');
  if (facts.amendmentsUnderReview > 0) reasons.push('AMENDMENT_AWAITING_APPROVAL');

  let health: CommercialHealth = 'HEALTHY';
  for (const reason of reasons) {
    const severity = HEALTH_REASON_SEVERITY[reason];
    if (RANK[severity] > RANK[health]) health = severity;
  }
  return { health, reasons };
}
