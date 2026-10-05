import type { Prisma } from '@company-ops/db';
import type { PermissionKey, Scope } from '@company-ops/shared';

import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { hasPermission, scopesFor } from '../authorization/effective-permissions.js';
import type { Principal } from '../authorization/policy.js';
import type { AttentionItem, AttentionScope, AttentionSeverity } from '../dashboard/engine/attention.js';
import { dashboardLink } from '../dashboard/links.js';
import { addDays, daysBetween } from '../projects/business-date.js';
import { fullContractWhere, fullTenderWhere } from './commercial-access.js';
import { dateOnly, organizationToday } from './commercial-support.js';
import { noticeApproachingWhere, renewalRequiredWhere } from './contract.service.js';
import { corporateDocumentListWhere } from './corporate-document.service.js';
import {
  amendmentKey,
  CLOSED_CONTRACT_STATUSES,
  contractKey,
  LIVE_CONTRACT_STATUSES,
} from './engine/contract-state.js';
import { GUARANTEE_EXPIRING_DAYS } from './engine/dates.js';
import { ACTIVE_TENDER_STATUSES, CLOSED_TENDER_STATUSES, tenderKey } from './engine/tender-state.js';

/** Permissions whose scope changes the commercial attention items (cache key input). */
export const COMMERCIAL_ATTENTION_PERMISSIONS: readonly PermissionKey[] = [
  'tender.view',
  'tender.review',
  'tender.approve',
  'contract.view',
  'contract.approve',
  'corporate_document.view',
  'corporate_document.restricted.view',
  'corporate_document.manage',
];

/** Contracts expiring within this many days raise an attention item. */
export const ATTENTION_EXPIRY_DAYS = 30;
/** Tenders not ready within this many days of the deadline are at risk. */
export const ATTENTION_DEADLINE_DAYS = 7;

const SCOPE_ORDER: readonly Scope[] = ['ORG', 'DEPARTMENT', 'PROJECT', 'TEAM', 'SELF'];
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const OPEN_OCCURRENCE = ['UPCOMING', 'IN_PROGRESS'] as const;
const OPEN_MILESTONE = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'] as const;

function scopeOf(principal: Principal, permission: PermissionKey): AttentionScope {
  const held = new Set(scopesFor(principal.permissions, permission));
  return SCOPE_ORDER.find((scope) => held.has(scope)) ?? 'SELF';
}

/** Instant a calendar-date condition started (start of that day, UTC; ordering only). */
const startOf = (date: string): string => `${date}T00:00:00.000Z`;

/**
 * Commercial rules of the Needs Attention feed (spec §51, §56): tender deadlines at risk, reviews and
 * requirements waiting for the caller, renewal notice and decision dates, expiring contracts,
 * overdue obligations and milestones, expired/expiring guarantees, amendments waiting for the
 * caller's approval and expiring corporate documents. Records are visible at FULL level, or are the
 * caller's own work items. Each rule reads at most `limit` rows; `limited` reports reaching it.
 */
export async function commercialAttention(
  db: TenantScopedClient,
  principal: Principal,
  organizationId: string,
  now: Date,
  limit: number,
): Promise<{ items: AttentionItem[]; limited: boolean }> {
  const items: AttentionItem[] = [];
  let limited = false;
  const take = <T>(rows: readonly T[]): readonly T[] => {
    if (rows.length >= limit) limited = true;
    return rows;
  };
  const me = principal.memberId;
  const holdsTender = hasPermission(principal.permissions, 'tender.view');
  const holdsContract = hasPermission(principal.permissions, 'contract.view');
  const tenderWhere = fullTenderWhere(principal);
  const contractWhere = fullContractWhere(principal);
  const { today } = await organizationToday(db, organizationId, now);
  const todayDate = day(today);

  // Tenders: deadline at risk (not ready close to the deadline, or deadline passed unsubmitted).
  if (holdsTender && tenderWhere !== null) {
    const scope = scopeOf(principal, 'tender.view');
    const rows = take(
      await db.tender.findMany({
        where: {
          organizationId,
          AND: [
            { organizationId },
            tenderWhere,
            { status: { in: [...ACTIVE_TENDER_STATUSES] } },
            { submissionDeadlineAt: { lte: new Date(now.getTime() + ATTENTION_DEADLINE_DAYS * 86_400_000) } },
            {
              OR: [
                { submissionDeadlineAt: { lt: now } },
                {
                  status: { in: ['PREPARING', 'INTERNAL_REVIEW'] },
                  mandatoryApproved: { lt: db.tender.fields.mandatoryApplicable },
                },
              ],
            },
          ],
        },
        orderBy: [{ submissionDeadlineAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          number: true,
          year: true,
          submissionDeadlineAt: true,
          mandatoryApproved: true,
          mandatoryApplicable: true,
        },
      }),
    );
    for (const row of rows) {
      if (row.submissionDeadlineAt === null) continue;
      const hoursLeft = (row.submissionDeadlineAt.getTime() - now.getTime()) / 3_600_000;
      items.push({
        key: `TENDER_DEADLINE_AT_RISK:${row.id}`,
        type: 'TENDER_DEADLINE_AT_RISK',
        severity: hoursLeft <= 48 ? 'CRITICAL' : 'HIGH',
        params: {
          key: tenderKey(row.year, row.number),
          approved: row.mandatoryApproved,
          applicable: row.mandatoryApplicable,
          passed: hoursLeft < 0 ? 1 : 0,
        },
        entity: { type: 'tender', id: row.id },
        occurredAt: row.submissionDeadlineAt.toISOString(),
        link: dashboardLink(`/tenders/${row.id}`, {}, 'overview'),
        scope,
      });
    }
  }

  // Reviews waiting for the caller (assigned reviewers always see the tender).
  const reviews = take(
    await db.tenderReview.findMany({
      where: { organizationId, reviewerMemberId: me, status: 'PENDING', gate: { status: 'OPEN' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        createdAt: true,
        gate: { select: { gate: true, openedAt: true } },
        tender: { select: { id: true, number: true, year: true } },
      },
    }),
  );
  for (const row of reviews) {
    const final = row.gate.gate === 'FINAL';
    const type = final ? 'TENDER_FINAL_APPROVAL' : 'TENDER_REVIEW_WAITING';
    items.push({
      key: `${type}:${row.id}`,
      type,
      severity: final ? 'HIGH' : 'MEDIUM',
      params: { key: tenderKey(row.tender.year, row.tender.number), gate: row.gate.gate },
      entity: { type: 'tender_review', id: row.id },
      occurredAt: (row.gate.openedAt ?? row.createdAt).toISOString(),
      link: dashboardLink(`/tenders/${row.tender.id}`, {}, 'reviews'),
      scope: 'SELF',
    });
  }

  // The caller's own overdue requirements.
  const requirements = take(
    await db.tenderRequirement.findMany({
      where: {
        organizationId,
        ownerMemberId: me,
        status: { notIn: ['APPROVED', 'NOT_APPLICABLE'] },
        dueDate: { lt: todayDate },
        tender: { status: { in: [...ACTIVE_TENDER_STATUSES] } },
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, dueDate: true, mandatory: true, tender: { select: { id: true, number: true, year: true } } },
    }),
  );
  for (const row of requirements) {
    const due = dateOnly(row.dueDate) ?? today;
    items.push({
      key: `TENDER_REQUIREMENT_OVERDUE:${row.id}`,
      type: 'TENDER_REQUIREMENT_OVERDUE',
      severity: row.mandatory ? 'HIGH' : 'MEDIUM',
      params: { key: tenderKey(row.tender.year, row.tender.number), days: daysBetween(due, today) },
      entity: { type: 'tender_requirement', id: row.id },
      occurredAt: startOf(due),
      link: dashboardLink(`/tenders/${row.tender.id}`, {}, 'requirements'),
      scope: 'SELF',
    });
  }

  // Contract dates (FULL visibility). One item per contract; the most urgent rule wins in dedupe.
  if (holdsContract && contractWhere !== null) {
    const scope = scopeOf(principal, 'contract.view');
    const contractSelect = {
      id: true,
      number: true,
      year: true,
      currentExpiryDate: true,
      renewalNoticeDeadline: true,
      renewalDecisionDate: true,
    } as const;
    const base = { organizationId };
    const notice = take(
      await db.contract.findMany({
        where: { organizationId, AND: [base, contractWhere, noticeApproachingWhere(today)] },
        orderBy: [{ renewalNoticeDeadline: 'asc' }, { id: 'asc' }],
        take: limit,
        select: contractSelect,
      }),
    );
    for (const row of notice) {
      const date = dateOnly(row.renewalNoticeDeadline) ?? today;
      items.push({
        key: `CONTRACT_NOTICE_DEADLINE:${row.id}`,
        type: 'CONTRACT_NOTICE_DEADLINE',
        severity: daysBetween(today, date) <= 7 ? 'CRITICAL' : 'HIGH',
        params: { key: contractKey(row.year, row.number), date, days: daysBetween(today, date) },
        entity: { type: 'contract', id: row.id },
        occurredAt: startOf(date),
        link: dashboardLink(`/contracts/${row.id}`, {}, 'renewal'),
        scope,
      });
    }
    const renewal = take(
      await db.contract.findMany({
        where: { organizationId, AND: [base, contractWhere, renewalRequiredWhere(today)] },
        orderBy: [{ currentExpiryDate: 'asc' }, { id: 'asc' }],
        take: limit,
        select: contractSelect,
      }),
    );
    for (const row of renewal) {
      const date = dateOnly(row.renewalDecisionDate) ?? dateOnly(row.currentExpiryDate) ?? today;
      items.push({
        key: `CONTRACT_RENEWAL_DECISION:${row.id}`,
        type: 'CONTRACT_RENEWAL_DECISION',
        severity: 'MEDIUM',
        params: { key: contractKey(row.year, row.number), date },
        entity: { type: 'contract', id: row.id },
        occurredAt: startOf(date),
        link: dashboardLink(`/contracts/${row.id}`, {}, 'renewal'),
        scope,
      });
    }
    const expiring = take(
      await db.contract.findMany({
        where: {
          organizationId,
          AND: [
            base,
            contractWhere,
            { status: { in: [...LIVE_CONTRACT_STATUSES] } },
            { currentExpiryDate: { gte: todayDate, lte: day(addDays(today, ATTENTION_EXPIRY_DAYS)) } },
          ],
        },
        orderBy: [{ currentExpiryDate: 'asc' }, { id: 'asc' }],
        take: limit,
        select: contractSelect,
      }),
    );
    for (const row of expiring) {
      const date = dateOnly(row.currentExpiryDate) ?? today;
      items.push({
        key: `CONTRACT_EXPIRING:${row.id}`,
        type: 'CONTRACT_EXPIRING',
        severity: daysBetween(today, date) <= 7 ? 'HIGH' : 'MEDIUM',
        params: { key: contractKey(row.year, row.number), date, days: daysBetween(today, date) },
        entity: { type: 'contract', id: row.id },
        occurredAt: startOf(date),
        link: dashboardLink(`/contracts/${row.id}`, {}, 'overview'),
        scope,
      });
    }
  }

  // Overdue obligations and milestones: FULL contracts, or the caller's own items.
  const workContract =
    holdsContract && contractWhere !== null
      ? { OR: [{ ownerMemberId: me }, { contract: contractWhere }] }
      : { ownerMemberId: me };
  const occurrences = take(
    await db.contractObligationOccurrence.findMany({
      where: {
        organizationId,
        status: { in: [...OPEN_OCCURRENCE] },
        dueDate: { lt: todayDate },
        contract: { status: { notIn: [...CLOSED_CONTRACT_STATUSES] } },
        ...workContract,
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        dueDate: true,
        ownerMemberId: true,
        obligation: { select: { criticality: true } },
        contract: { select: { id: true, number: true, year: true } },
      },
    }),
  );
  for (const row of occurrences) {
    const due = dateOnly(row.dueDate) ?? today;
    const severity: AttentionSeverity = row.obligation.criticality === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
    items.push({
      key: `OBLIGATION_OVERDUE:${row.id}`,
      type: 'OBLIGATION_OVERDUE',
      severity,
      params: { key: contractKey(row.contract.year, row.contract.number), days: daysBetween(due, today) },
      entity: { type: 'obligation_occurrence', id: row.id },
      occurredAt: startOf(due),
      link: dashboardLink(`/contracts/${row.contract.id}`, {}, 'obligations'),
      scope: row.ownerMemberId === me ? 'SELF' : scopeOf(principal, 'contract.view'),
    });
  }
  const milestones = take(
    await db.contractMilestone.findMany({
      where: {
        organizationId,
        status: { in: [...OPEN_MILESTONE] },
        dueDate: { lt: todayDate },
        contract: { status: { notIn: [...CLOSED_CONTRACT_STATUSES] } },
        ...workContract,
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        dueDate: true,
        ownerMemberId: true,
        contract: { select: { id: true, number: true, year: true } },
      },
    }),
  );
  for (const row of milestones) {
    const due = dateOnly(row.dueDate) ?? today;
    items.push({
      key: `MILESTONE_OVERDUE:${row.id}`,
      type: 'MILESTONE_OVERDUE',
      severity: 'HIGH',
      params: { key: contractKey(row.contract.year, row.contract.number), days: daysBetween(due, today) },
      entity: { type: 'contract_milestone', id: row.id },
      occurredAt: startOf(due),
      link: dashboardLink(`/contracts/${row.contract.id}`, {}, 'milestones'),
      scope: row.ownerMemberId === me ? 'SELF' : scopeOf(principal, 'contract.view'),
    });
  }

  // Guarantees of open tenders/contracts visible at FULL level, or owned by the caller.
  const parents: Prisma.GuaranteeWhereInput[] = [{ ownerMemberId: me }];
  if (holdsTender && tenderWhere !== null) {
    parents.push({ tender: { AND: [tenderWhere, { status: { notIn: [...CLOSED_TENDER_STATUSES] } }] } });
  }
  if (holdsContract && contractWhere !== null) {
    parents.push({ contract: { AND: [contractWhere, { status: { notIn: [...CLOSED_CONTRACT_STATUSES] } }] } });
  }
  const guarantees = take(
    await db.guarantee.findMany({
      where: {
        organizationId,
        OR: [
          { status: 'EXPIRED' },
          { status: 'ACTIVE', expiryDate: { lte: day(addDays(today, GUARANTEE_EXPIRING_DAYS)) } },
        ],
        AND: [{ OR: parents }],
      },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        status: true,
        expiryDate: true,
        ownerMemberId: true,
        tender: { select: { id: true, number: true, year: true, status: true } },
        contract: { select: { id: true, number: true, year: true, status: true } },
      },
    }),
  );
  for (const row of guarantees) {
    if (row.tender !== null && CLOSED_TENDER_STATUSES.includes(row.tender.status)) continue;
    if (row.contract !== null && CLOSED_CONTRACT_STATUSES.includes(row.contract.status)) continue;
    const expiry = dateOnly(row.expiryDate) ?? today;
    const expired = row.status === 'EXPIRED' || expiry < today;
    const parentKey =
      row.tender !== null
        ? tenderKey(row.tender.year, row.tender.number)
        : row.contract !== null
          ? contractKey(row.contract.year, row.contract.number)
          : '';
    const path =
      row.tender !== null
        ? `/tenders/${row.tender.id}`
        : row.contract !== null
          ? `/contracts/${row.contract.id}`
          : '/contracts';
    const type = expired ? 'GUARANTEE_EXPIRED' : 'GUARANTEE_EXPIRING';
    items.push({
      key: `${type}:${row.id}`,
      type,
      severity: expired ? 'CRITICAL' : 'MEDIUM',
      params: { key: parentKey, date: expiry, days: daysBetween(today, expiry) },
      entity: { type: 'guarantee', id: row.id },
      occurredAt: startOf(expiry),
      link: dashboardLink(path, {}, 'guarantees'),
      scope:
        row.ownerMemberId === me ? 'SELF' : scopeOf(principal, row.tender !== null ? 'tender.view' : 'contract.view'),
    });
  }

  // Amendments waiting for the caller's approval (never their own).
  const approveWhere = fullContractWhere(principal, 'contract.approve');
  if (hasPermission(principal.permissions, 'contract.approve') && approveWhere !== null && contractWhere !== null) {
    const rows = take(
      await db.contractAmendment.findMany({
        where: {
          organizationId,
          status: 'UNDER_REVIEW',
          createdByMemberId: { not: me },
          contract: { AND: [contractWhere, approveWhere] },
        },
        orderBy: [{ submittedAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          number: true,
          submittedAt: true,
          createdAt: true,
          contract: { select: { id: true, number: true, year: true } },
        },
      }),
    );
    for (const row of rows) {
      items.push({
        key: `AMENDMENT_APPROVAL_WAITING:${row.id}`,
        type: 'AMENDMENT_APPROVAL_WAITING',
        severity: 'HIGH',
        params: { key: amendmentKey(row.contract.year, row.contract.number, row.number) },
        entity: { type: 'contract_amendment', id: row.id },
        occurredAt: (row.submittedAt ?? row.createdAt).toISOString(),
        link: dashboardLink(`/contracts/${row.contract.id}`, {}, 'amendments'),
        scope: scopeOf(principal, 'contract.approve'),
      });
    }
  }

  // Corporate documents expiring or expired (document managers).
  if (hasPermission(principal.permissions, 'corporate_document.manage')) {
    const where = corporateDocumentListWhere(principal, { validity: ['EXPIRING', 'EXPIRED'] }, today);
    if (where !== null) {
      const rows = take(
        await db.corporateDocument.findMany({
          where: { organizationId, AND: where },
          orderBy: [{ currentExpiryDate: 'asc' }, { id: 'asc' }],
          take: limit,
          select: { id: true, documentType: true, currentExpiryDate: true },
        }),
      );
      for (const row of rows) {
        const expiry = dateOnly(row.currentExpiryDate) ?? today;
        const expired = expiry < today;
        items.push({
          key: `CORPORATE_DOCUMENT_EXPIRING:${row.id}`,
          type: 'CORPORATE_DOCUMENT_EXPIRING',
          severity: expired ? 'HIGH' : 'MEDIUM',
          params: { documentType: row.documentType, date: expiry, days: daysBetween(today, expiry) },
          entity: { type: 'corporate_document', id: row.id },
          occurredAt: startOf(expiry),
          link: dashboardLink('/documents', { open: row.id }),
          scope: scopeOf(principal, 'corporate_document.manage'),
        });
      }
    }
  }

  return { items, limited };
}
