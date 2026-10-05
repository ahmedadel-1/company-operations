import type { CommercialHealth, ContractStatus, Prisma } from '@company-ops/db';

import { canAccessResource } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { daysBetween } from '../projects/business-date.js';
import { contractFacts } from './commercial-access.js';
import { dateOnly, iso, memberRefSelect, toPersonRef } from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { CONTRACT_EXPIRING_DAYS } from './engine/dates.js';
import type { ContractHealthReason } from './engine/health.js';
import { toMoney } from './engine/money.js';
import type { Money } from './engine/money.js';
import { LIVE_CONTRACT_STATUSES, contractKey } from './engine/contract-state.js';

export const contractSummarySelect = {
  id: true,
  number: true,
  year: true,
  title: true,
  counterpartyName: true,
  status: true,
  health: true,
  healthReasons: true,
  currentExpiryDate: true,
  renewalNoticeDeadline: true,
  currentValue: true,
  currency: true,
  updatedAt: true,
  version: true,
  ownerMemberId: true,
  projectId: true,
  customer: { select: { id: true, name: true } },
  project: { select: { id: true, code: true, name: true } },
  owner: {
    select: { ...memberRefSelect, profile: { select: { fullName: true, employmentStatus: true, departmentId: true } } },
  },
} satisfies Prisma.ContractSelect;
export type ContractSummaryRow = Prisma.ContractGetPayload<{ select: typeof contractSummarySelect }>;

export interface ContractSummaryView {
  readonly id: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly counterpartyName: string | null;
  readonly project: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly status: ContractStatus;
  readonly expiring: boolean;
  readonly health: CommercialHealth;
  readonly healthReasons: ContractHealthReason[];
  readonly owner: PersonRef;
  readonly currentExpiryDate: string | null;
  readonly renewalNoticeDeadline: string | null;
  readonly currentValue?: Money;
  readonly updatedAt: string;
  readonly version: number;
}

/** The derived EXPIRING state: in force with the current expiry inside the 90-day window. */
export function isExpiring(status: ContractStatus, currentExpiryDate: string | null, today: string): boolean {
  return (
    LIVE_CONTRACT_STATUSES.includes(status) &&
    currentExpiryDate !== null &&
    currentExpiryDate >= today &&
    daysBetween(today, currentExpiryDate) <= CONTRACT_EXPIRING_DAYS
  );
}

/** Financial visibility of one listed contract (FULL level and `contract.financial.view` in scope). */
export function contractRowFinancialVisible(
  principal: Principal,
  organizationId: string,
  row: ContractSummaryRow,
): boolean {
  const facts = contractFacts(organizationId, row);
  return (
    canAccessResource(principal, 'contract.view', facts) &&
    canAccessResource(principal, 'contract.financial.view', facts)
  );
}

const HEALTH_REASONS: ReadonlySet<string> = new Set<ContractHealthReason>([
  'EXPIRY_APPROACHING',
  'EXPIRED_WITHOUT_DECISION',
  'RENEWAL_DECISION_OVERDUE',
  'NOTICE_DEADLINE_APPROACHING',
  'NOTICE_DEADLINE_PASSED',
  'OBLIGATION_OVERDUE',
  'CRITICAL_OBLIGATION_OVERDUE',
  'MILESTONE_OVERDUE',
  'GUARANTEE_EXPIRING',
  'GUARANTEE_EXPIRED',
  'SIGNED_CONTRACT_MISSING',
  'AMENDMENT_AWAITING_APPROVAL',
]);

export function toHealthReasons(stored: readonly string[]): ContractHealthReason[] {
  return stored.filter((reason): reason is ContractHealthReason => HEALTH_REASONS.has(reason));
}

export function toContractSummary(row: ContractSummaryRow, financial: boolean, today: string): ContractSummaryView {
  const currentExpiryDate = dateOnly(row.currentExpiryDate);
  const value = financial ? toMoney(row.currentValue, row.currency) : undefined;
  return {
    id: row.id,
    number: row.number,
    key: contractKey(row.year, row.number),
    title: row.title,
    customer: row.customer === null ? null : { id: row.customer.id, name: row.customer.name },
    counterpartyName: row.counterpartyName,
    project: row.project === null ? null : { id: row.project.id, code: row.project.code, name: row.project.name },
    status: row.status,
    expiring: isExpiring(row.status, currentExpiryDate, today),
    health: row.health,
    healthReasons: toHealthReasons(row.healthReasons),
    owner: toPersonRef(row.owner),
    currentExpiryDate,
    renewalNoticeDeadline: dateOnly(row.renewalNoticeDeadline),
    ...(value === undefined ? {} : { currentValue: value }),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  };
}

export const contractRefSelect = {
  id: true,
  number: true,
  year: true,
  title: true,
  status: true,
} satisfies Prisma.ContractSelect;

export function toContractRef(row: {
  id: string;
  number: number;
  year: number;
  title: string;
  status: ContractStatus;
}): {
  id: string;
  key: string;
  title: string;
  status: ContractStatus;
} {
  return { id: row.id, key: contractKey(row.year, row.number), title: row.title, status: row.status };
}
