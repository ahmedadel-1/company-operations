import type { Prisma, TenderStatus } from '@company-ops/db';

import { canAccessResource } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { tenderFacts } from './commercial-access.js';
import { iso, isoOrNull, memberRefSelect, toPersonRef } from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { readinessView } from './engine/readiness.js';
import type { ReadinessView, RequirementFacts } from './engine/readiness.js';
import { toMoney } from './engine/money.js';
import type { Money } from './engine/money.js';
import { ACTIVE_TENDER_STATUSES, PREPARATION_STATUSES, isOpenForWork, tenderKey } from './engine/tender-state.js';

export const tenderSummarySelect = {
  id: true,
  number: true,
  year: true,
  title: true,
  counterpartyName: true,
  status: true,
  bidDecision: true,
  priority: true,
  submissionDeadlineAt: true,
  submissionDeadlineTimeZone: true,
  estimatedValue: true,
  currency: true,
  updatedAt: true,
  version: true,
  ownerMemberId: true,
  technicalLeadMemberId: true,
  commercialLeadMemberId: true,
  relatedProjectId: true,
  requirementsTotal: true,
  mandatoryApplicable: true,
  mandatoryApproved: true,
  optionalApplicable: true,
  optionalApproved: true,
  blockedRequirements: true,
  unassignedRequirements: true,
  customer: { select: { id: true, name: true } },
  owner: {
    select: { ...memberRefSelect, profile: { select: { fullName: true, employmentStatus: true, departmentId: true } } },
  },
} satisfies Prisma.TenderSelect;
export type TenderSummaryRow = Prisma.TenderGetPayload<{ select: typeof tenderSummarySelect }>;

export const tenderDetailSelect = {
  ...tenderSummarySelect,
  internalReference: true,
  description: true,
  tenderType: true,
  procurementMethod: true,
  publishedAt: true,
  clarificationDeadlineAt: true,
  submissionMethod: true,
  submissionReference: true,
  submittedAt: true,
  awardDate: true,
  awardValue: true,
  awardCurrency: true,
  awardReference: true,
  awardNotes: true,
  lossReason: true,
  winningCompany: true,
  winningValue: true,
  ourSubmittedValue: true,
  debriefNotes: true,
  lessonsLearned: true,
  cancelReason: true,
  reviewRound: true,
  archivedAt: true,
  createdAt: true,
  relatedProject: { select: { id: true, code: true, name: true } },
  technicalLead: { select: memberRefSelect },
  commercialLead: { select: memberRefSelect },
  submittedBy: { select: memberRefSelect },
  createdBy: { select: memberRefSelect },
} satisfies Prisma.TenderSelect;
export type TenderDetailRow = Prisma.TenderGetPayload<{ select: typeof tenderDetailSelect }>;

export type TenderAlert =
  | 'DEADLINE_PASSED'
  | 'DEADLINE_TOMORROW'
  | 'DEADLINE_SOON'
  | 'MANDATORY_MISSING'
  | 'BLOCKED_REQUIREMENTS'
  | 'UNASSIGNED_REQUIREMENTS'
  | 'BID_DECISION_PENDING';

export interface TenderSummaryView {
  readonly id: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly customer: { readonly id: string; readonly name: string } | null;
  readonly counterpartyName: string | null;
  readonly status: TenderStatus;
  readonly bidDecision: TenderSummaryRow['bidDecision'];
  readonly priority: TenderSummaryRow['priority'];
  readonly owner: PersonRef;
  readonly submissionDeadlineAt: string | null;
  readonly submissionDeadlineTimeZone: string | null;
  readonly readiness: ReadinessView;
  readonly alerts: TenderAlert[];
  readonly estimatedValue?: Money;
  readonly updatedAt: string;
  readonly version: number;
}

const DAY_MS = 86_400_000;

export function tenderAlerts(
  row: Pick<TenderSummaryRow, 'status' | 'submissionDeadlineAt' | 'blockedRequirements' | 'unassignedRequirements'>,
  readiness: ReadinessView,
  now: Date,
): TenderAlert[] {
  const alerts: TenderAlert[] = [];
  const deadline = row.submissionDeadlineAt;
  if (deadline !== null && ACTIVE_TENDER_STATUSES.includes(row.status)) {
    const remaining = deadline.getTime() - now.getTime();
    if (remaining < 0) alerts.push('DEADLINE_PASSED');
    else if (remaining <= DAY_MS) alerts.push('DEADLINE_TOMORROW');
    else if (remaining <= 7 * DAY_MS) alerts.push('DEADLINE_SOON');
  }
  if (PREPARATION_STATUSES.includes(row.status) && readiness.state === 'NOT_READY') alerts.push('MANDATORY_MISSING');
  if (isOpenForWork(row.status) && row.blockedRequirements > 0) alerts.push('BLOCKED_REQUIREMENTS');
  if (isOpenForWork(row.status) && row.unassignedRequirements > 0) alerts.push('UNASSIGNED_REQUIREMENTS');
  if (row.status === 'BID_DECISION_PENDING') alerts.push('BID_DECISION_PENDING');
  return alerts;
}

/** Financial visibility of one listed tender (FULL level and `tender.financial.view` in scope). */
export function rowFinancialVisible(principal: Principal, organizationId: string, row: TenderSummaryRow): boolean {
  const facts = tenderFacts(organizationId, row);
  return (
    canAccessResource(principal, 'tender.view', facts) && canAccessResource(principal, 'tender.financial.view', facts)
  );
}

export function toTenderSummary(
  row: TenderSummaryRow,
  financial: boolean,
  now: Date,
  details: { readonly requirements: readonly RequirementFacts[]; readonly today: string } | null = null,
): TenderSummaryView {
  const readiness = readinessView(row, details);
  const estimated = financial ? toMoney(row.estimatedValue, row.currency) : undefined;
  return {
    id: row.id,
    number: row.number,
    key: tenderKey(row.year, row.number),
    title: row.title,
    customer: row.customer === null ? null : { id: row.customer.id, name: row.customer.name },
    counterpartyName: row.counterpartyName,
    status: row.status,
    bidDecision: row.bidDecision,
    priority: row.priority,
    owner: toPersonRef(row.owner),
    submissionDeadlineAt: isoOrNull(row.submissionDeadlineAt),
    submissionDeadlineTimeZone: row.submissionDeadlineTimeZone,
    readiness,
    alerts: tenderAlerts(row, readiness, now),
    ...(estimated === undefined ? {} : { estimatedValue: estimated }),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  };
}

export const tenderRefSelect = {
  id: true,
  number: true,
  year: true,
  title: true,
  status: true,
} satisfies Prisma.TenderSelect;

export function toTenderRef(row: { id: string; number: number; year: number; title: string; status: TenderStatus }): {
  id: string;
  key: string;
  title: string;
  status: TenderStatus;
} {
  return { id: row.id, key: tenderKey(row.year, row.number), title: row.title, status: row.status };
}
