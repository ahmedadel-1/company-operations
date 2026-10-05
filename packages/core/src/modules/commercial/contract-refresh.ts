import type { CommercialHealth, Prisma } from '@company-ops/db';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { addDays } from '../projects/business-date.js';
import { dateOnly } from './commercial-support.js';
import { GUARANTEE_EXPIRING_DAYS } from './engine/dates.js';
import { evaluateHealth } from './engine/health.js';
import type { ContractHealthReason } from './engine/health.js';
import { formatAmount } from './engine/money.js';
import { projectContract } from './engine/projection.js';

export interface ContractRefresh {
  readonly health: CommercialHealth;
  readonly reasons: readonly ContractHealthReason[];
  readonly healthChanged: boolean;
  readonly previousValue: string;
  readonly currentValue: string;
  readonly previousExpiryDate: string | null;
  readonly currentExpiryDate: string | null;
  readonly projectionChanged: boolean;
}

const OPEN_OCCURRENCE: Prisma.ContractObligationOccurrenceWhereInput = { status: { in: ['UPCOMING', 'IN_PROGRESS'] } };
const OPEN_MILESTONE: Prisma.ContractMilestoneWhereInput = {
  status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'] },
};

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * Rebuilds a contract's projection (current value, current expiry, notice deadline) from its baseline,
 * EFFECTIVE amendments and RENEWED/EXTENDED renewal actions, then re-evaluates and stores its health
 * (ADR-0026). Runs inside the transaction of every relevant change, after the contract's aggregate
 * lock, and daily from the commercial monitor; it is also the projection's consistency check (a
 * rebuild of an unchanged contract changes nothing). Does not bump the contract's version.
 */
export async function refreshContract(
  tx: TenantDb,
  organizationId: string,
  contractId: string,
  today: string,
): Promise<ContractRefresh> {
  const contract = await tx.contract.findFirstOrThrow({
    where: { organizationId, id: contractId },
    select: {
      status: true,
      renewalType: true,
      originalValue: true,
      currentValue: true,
      originalExpiryDate: true,
      currentExpiryDate: true,
      renewalNoticeDeadline: true,
      noticePeriodDays: true,
      renewalDecisionDate: true,
      renewalDecision: true,
      health: true,
      healthReasons: true,
      healthEvaluatedOn: true,
    },
  });
  const [amendments, renewals] = await Promise.all([
    tx.contractAmendment.findMany({
      where: { organizationId, contractId, status: 'EFFECTIVE' },
      select: { valueDelta: true, newExpiryDate: true, activatedAt: true, createdAt: true },
    }),
    tx.contractRenewalAction.findMany({
      where: { organizationId, contractId, action: { in: ['RENEWED', 'EXTENDED'] }, newExpiryDate: { not: null } },
      select: { newExpiryDate: true, createdAt: true },
    }),
  ]);
  const projection = projectContract({
    originalValue: contract.originalValue,
    originalExpiryDate: dateOnly(contract.originalExpiryDate),
    noticePeriodDays: contract.noticePeriodDays,
    amendments: amendments.map((amendment) => ({
      valueDelta: amendment.valueDelta,
      newExpiryDate: dateOnly(amendment.newExpiryDate),
      appliedAt: amendment.activatedAt ?? amendment.createdAt,
    })),
    renewals: renewals.map((renewal) => ({
      newExpiryDate: dateOnly(renewal.newExpiryDate),
      appliedAt: renewal.createdAt,
    })),
  });

  const todayDate = day(today);
  const guaranteeWindowEnd = day(addDays(today, GUARANTEE_EXPIRING_DAYS));
  const [
    overdueObligations,
    overdueCriticalObligations,
    overdueMilestones,
    expiringGuarantees,
    expiredGuarantees,
    signed,
    underReview,
  ] = await Promise.all([
    tx.contractObligationOccurrence.count({
      where: { organizationId, contractId, ...OPEN_OCCURRENCE, dueDate: { lt: todayDate } },
    }),
    tx.contractObligationOccurrence.count({
      where: {
        organizationId,
        contractId,
        ...OPEN_OCCURRENCE,
        dueDate: { lt: todayDate },
        obligation: { criticality: 'CRITICAL' },
      },
    }),
    tx.contractMilestone.count({
      where: { organizationId, contractId, ...OPEN_MILESTONE, dueDate: { lt: todayDate } },
    }),
    tx.guarantee.count({
      where: { organizationId, contractId, status: 'ACTIVE', expiryDate: { gte: todayDate, lte: guaranteeWindowEnd } },
    }),
    tx.guarantee.count({
      where: {
        organizationId,
        contractId,
        OR: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expiryDate: { lt: todayDate } }],
      },
    }),
    tx.commercialDocument.count({
      where: { organizationId, contractId, category: 'SIGNED_CONTRACT', currentVersion: { gt: 0 } },
    }),
    tx.contractAmendment.count({ where: { organizationId, contractId, status: 'UNDER_REVIEW' } }),
  ]);
  const result = evaluateHealth(
    {
      status: contract.status,
      renewalType: contract.renewalType,
      currentExpiryDate: projection.currentExpiryDate,
      renewalDecisionDate: dateOnly(contract.renewalDecisionDate),
      renewalNoticeDeadline: projection.renewalNoticeDeadline,
      renewalDecided: contract.renewalDecision !== null,
      overdueObligations,
      overdueCriticalObligations,
      overdueMilestones,
      expiringGuarantees,
      expiredGuarantees,
      hasSignedContract: signed > 0,
      amendmentsUnderReview: underReview,
    },
    today,
  );

  const previousExpiryDate = dateOnly(contract.currentExpiryDate);
  const projectionChanged =
    !contract.currentValue.equals(projection.currentValue) ||
    previousExpiryDate !== projection.currentExpiryDate ||
    dateOnly(contract.renewalNoticeDeadline) !== projection.renewalNoticeDeadline;
  const healthChanged =
    contract.health !== result.health || contract.healthReasons.join(',') !== result.reasons.join(',');
  // Written only on change, so the daily re-evaluation does not touch `updated_at` of every contract.
  if (projectionChanged || healthChanged || contract.healthEvaluatedOn === null) {
    await tx.contract.updateMany({
      where: { organizationId, id: contractId },
      data: {
        currentValue: projection.currentValue,
        currentExpiryDate: projection.currentExpiryDate === null ? null : day(projection.currentExpiryDate),
        renewalNoticeDeadline: projection.renewalNoticeDeadline === null ? null : day(projection.renewalNoticeDeadline),
        health: result.health,
        healthReasons: [...result.reasons],
        healthEvaluatedOn: todayDate,
      },
    });
  }
  return {
    health: result.health,
    reasons: result.reasons,
    healthChanged,
    previousValue: formatAmount(contract.currentValue),
    currentValue: formatAmount(projection.currentValue),
    previousExpiryDate,
    currentExpiryDate: projection.currentExpiryDate,
    projectionChanged,
  };
}
