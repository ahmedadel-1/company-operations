import type { Prisma, TenderStatus } from '@company-ops/db';
import type {
  BidDecisionRequest,
  CorrectSubmissionRequest,
  CreateAddendumRequest,
  CreateClarificationRequest,
  CreateTenderRequest,
  RecordAwardRequest,
  RecordLossRequest,
  SubmitTenderRequest,
  TenderListQuery,
  TenderTransitionRequest,
  UpdateClarificationRequest,
  UpdateTenderRequest,
} from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { escapeLike } from '../../platform/db/like.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { nextCounterValue } from '../../platform/db/sql/counters.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { zonedInstant } from '../attendance/engine/time.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { canAccessResource } from '../authorization/policy.js';
import type { Principal, ResourceFacts } from '../authorization/policy.js';
import { loadProjectForAccess } from '../projects/project-access.js';
import { addDays } from '../projects/business-date.js';
import {
  assertCan,
  canViewCommercialDocument,
  canViewTenderFinancial,
  hiddenDocumentEventsWhere,
  loadTenderForAccess,
  loadVisibleTender,
  versionClassificationSelect,
  visibleContractWhere,
  visibleDocumentWhere,
  visibleTenderWhere,
  visibleVersionId,
} from './commercial-access.js';
import type { LoadedTender } from './commercial-access.js';
import {
  announceCommercialChange,
  appendTenderEvent,
  assertActiveMembers,
  assertTimeZone,
  dateOnly,
  eventParams,
  iso,
  isoOrNull,
  memberRefSelect,
  notifyMembers,
  organizationToday,
  personOrNull,
  toPersonRef,
} from './commercial-support.js';
import type { EventParams, PersonRef } from './commercial-support.js';
import { contractKey } from './engine/contract-state.js';
import { decimal, toMoney } from './engine/money.js';
import type { Money } from './engine/money.js';
import type { RequirementFacts } from './engine/readiness.js';
import { readinessState } from './engine/readiness.js';
import {
  ACTIVE_TENDER_STATUSES,
  BID_DECISION_STATUSES,
  CLOSED_TENDER_STATUSES,
  SUBMITTED_STATUSES,
  checkManualTransition,
  deadlineEditableDirectly,
  isOpenForWork,
  manualTargets,
  statusAfterBidDecision,
  tenderKey,
} from './engine/tender-state.js';
import { rowFinancialVisible, tenderDetailSelect, tenderSummarySelect, toTenderSummary } from './tender-views.js';
import type { TenderDetailRow, TenderSummaryView } from './tender-views.js';

export interface TenderAccessView {
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly canManageRequirements: boolean;
  readonly canDecideBid: boolean;
  readonly canRequestReview: boolean;
  readonly canSubmit: boolean;
  readonly canRecordAward: boolean;
  readonly canRecordLoss: boolean;
  readonly canCreateContract: boolean;
  readonly canManageDocuments: boolean;
  readonly canViewFinancial: boolean;
  readonly canViewConfidentialDocuments: boolean;
  readonly canManageGuarantees: boolean;
  readonly transitions: TenderStatus[];
}

export interface TenderView extends TenderSummaryView {
  readonly accessLevel: 'FULL' | 'INVOLVED';
  readonly internalReference: string | null;
  readonly description: string | null;
  readonly relatedProject: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly tenderType: TenderDetailRow['tenderType'];
  readonly procurementMethod: string | null;
  readonly publishedAt: string | null;
  readonly clarificationDeadlineAt: string | null;
  readonly technicalLead: PersonRef | null;
  readonly commercialLead: PersonRef | null;
  readonly submission: {
    readonly method: NonNullable<TenderDetailRow['submissionMethod']>;
    readonly reference: string | null;
    readonly submittedAt: string;
    readonly submittedBy: PersonRef | null;
  } | null;
  readonly award: {
    readonly awardDate: string;
    readonly reference: string | null;
    readonly notes: string | null;
    readonly value?: Money;
  } | null;
  readonly loss: {
    readonly reason: NonNullable<TenderDetailRow['lossReason']>;
    readonly winningCompany: string | null;
    readonly debriefNotes: string | null;
    readonly lessonsLearned: string | null;
    readonly winningValue?: Money;
    readonly ourSubmittedValue?: Money;
  } | null;
  readonly cancelReason: string | null;
  readonly reviewRound: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: PersonRef | null;
  readonly contracts: { readonly id: string; readonly key: string; readonly title: string; readonly status: string }[];
  readonly pendingReviews: number;
  readonly access: TenderAccessView;
}

export interface BidDecisionView {
  readonly id: string;
  readonly decision: 'BID' | 'NO_BID';
  readonly criteria: Record<string, string>;
  readonly noBidReason: string | null;
  readonly comments: string | null;
  readonly decidedBy: PersonRef | null;
  readonly decidedAt: string;
}

export interface TenderSubmissionView {
  readonly id: string;
  readonly kind: 'SUBMISSION' | 'CORRECTION';
  readonly method: string;
  readonly reference: string | null;
  readonly notes: string | null;
  readonly submittedAt: string;
  readonly submittedBy: PersonRef | null;
  readonly evidence: {
    readonly documentId: string;
    readonly versionId: string;
    readonly title: string;
    readonly versionNumber: number;
  } | null;
  readonly correctsSubmissionId: string | null;
  readonly createdAt: string;
}

export interface TenderAddendumView {
  readonly id: string;
  readonly number: number;
  readonly reference: string | null;
  readonly summary: string;
  readonly receivedAt: string;
  readonly documentVersionId: string | null;
  readonly previousDeadlineAt: string | null;
  readonly previousTimeZone: string | null;
  readonly newDeadlineAt: string | null;
  readonly newTimeZone: string | null;
  readonly createdBy: PersonRef | null;
  readonly createdAt: string;
}

export interface TenderClarificationView {
  readonly id: string;
  readonly question: string;
  readonly reference: string | null;
  readonly status: 'OPEN' | 'SUBMITTED' | 'ANSWERED' | 'WITHDRAWN';
  readonly submittedAt: string | null;
  readonly response: string | null;
  readonly respondedAt: string | null;
  readonly createdBy: PersonRef | null;
  readonly createdAt: string;
  readonly version: number;
}

export interface CommercialEventView {
  readonly id: string;
  readonly type: string;
  readonly actor: PersonRef | null;
  readonly params: EventParams;
  readonly createdAt: string;
}

const CRITERIA_KEYS = [
  'technicalFit',
  'commercialAttractiveness',
  'resourcesAvailable',
  'requiredQualificationsAvailable',
  'deadlineFeasible',
  'strategicCustomer',
  'previousExperienceAvailable',
  'commercialRisk',
  'technicalRisk',
] as const;

/**
 * Requirements are created and worked while the bid is being prepared. They are frozen during
 * internal review and once ready for submission (reviewers approve a stable compliance matrix; a
 * change means withdrawing back to PREPARING) and after submission.
 */
export function requirementsEditable(status: TenderStatus): boolean {
  return (
    isOpenForWork(status) &&
    !SUBMITTED_STATUSES.includes(status) &&
    status !== 'INTERNAL_REVIEW' &&
    status !== 'READY_FOR_SUBMISSION'
  );
}

const SUBMITTED_EDITABLE_FIELDS = new Set([
  'description',
  'internalReference',
  'priority',
  'ownerMemberId',
  'technicalLeadMemberId',
  'commercialLeadMemberId',
  'version',
]);

/**
 * Tenders (ADR-0026, spec §12-§25): the pre-award opportunity from intake through bid/no-bid,
 * preparation, internal review, submission and award or loss. Every lifecycle change is a state
 * machine transition with optimistic concurrency; submission, award and loss are controlled,
 * idempotent operations; deadline changes after intake go through addenda and keep the old deadline.
 */
/**
 * Row filter of the tender list (visibility plus every list filter except paging). Dashboard numbers
 * are counted with the same builder, so a number and the list it links to always agree. Null when no
 * tender can be visible.
 */
export function tenderListWhere(
  db: TenantScopedClient,
  principal: Principal,
  query: Omit<TenderListQuery, 'cursor' | 'limit' | 'sort'>,
  now: Date,
  timeZone: string,
): Prisma.TenderWhereInput[] | null {
  const visible = visibleTenderWhere(principal);
  if (visible === null) return null;
  const and: Prisma.TenderWhereInput[] = [visible];
  const me = principal.memberId;
  if (query.view === 'mine') {
    and.push({
      OR: [
        { ownerMemberId: me },
        { technicalLeadMemberId: me },
        { commercialLeadMemberId: me },
        { requirements: { some: { OR: [{ ownerMemberId: me }, { reviewerMemberId: me }] } } },
        { reviews: { some: { reviewerMemberId: me, status: 'PENDING' } } },
      ],
    });
  }
  if (query.status !== undefined) and.push({ status: { in: [...query.status] } });
  else if (query.includeArchived !== true) and.push({ status: { not: 'ARCHIVED' } });
  if (query.bidDecision !== undefined) and.push({ bidDecision: { in: [...query.bidDecision] } });
  if (query.customerId !== undefined) and.push({ customerId: query.customerId });
  if (query.ownerMemberId !== undefined) and.push({ ownerMemberId: query.ownerMemberId });
  if (query.projectId !== undefined) and.push({ relatedProjectId: query.projectId });
  if (query.deadline !== undefined) {
    const days = query.deadline === 'next7' ? 7 : 30;
    and.push(
      query.deadline === 'overdue'
        ? { submissionDeadlineAt: { lt: now }, status: { in: [...ACTIVE_TENDER_STATUSES] } }
        : {
            submissionDeadlineAt: { gte: now, lte: new Date(now.getTime() + days * 86_400_000) },
            status: { in: [...ACTIVE_TENDER_STATUSES] },
          },
    );
  }
  if (query.readiness === 'no_mandatory') and.push({ mandatoryApplicable: 0 });
  if (query.readiness === 'ready') {
    and.push({ mandatoryApplicable: { gt: 0 }, mandatoryApproved: { equals: db.tender.fields.mandatoryApplicable } });
  }
  if (query.readiness === 'not_ready') and.push({ mandatoryApproved: { lt: db.tender.fields.mandatoryApplicable } });
  if (query.stage === 'final_approval') {
    and.push({ status: 'INTERNAL_REVIEW', reviewGates: { some: { gate: 'FINAL', status: 'OPEN' } } });
  }
  if (query.submittedFrom !== undefined)
    and.push({ submittedAt: { gte: zonedInstant(query.submittedFrom, 0, timeZone) } });
  if (query.submittedTo !== undefined) {
    and.push({ submittedAt: { lt: zonedInstant(addDays(query.submittedTo, 1), 0, timeZone) } });
  }
  if (query.awardedFrom !== undefined)
    and.push({ status: 'AWARDED', awardDate: { gte: new Date(`${query.awardedFrom}T00:00:00.000Z`) } });
  if (query.closedFrom !== undefined) {
    const from = zonedInstant(query.closedFrom, 0, timeZone);
    and.push({
      OR: [
        { status: 'AWARDED', awardDate: { gte: new Date(`${query.closedFrom}T00:00:00.000Z`) } },
        { status: 'LOST', events: { some: { type: 'tender.loss_recorded', createdAt: { gte: from } } } },
      ],
    });
  }
  if (query.q !== undefined) {
    const q = query.q.trim();
    const pattern = escapeLike(q);
    const numeric = /^(?:TND-\d{4}-)?0*(\d{1,9})$/i.exec(q);
    and.push({
      OR: [
        { title: { contains: pattern, mode: 'insensitive' } },
        { internalReference: { contains: pattern, mode: 'insensitive' } },
        { counterpartyName: { contains: pattern, mode: 'insensitive' } },
        { customer: { name: { contains: pattern, mode: 'insensitive' } } },
        ...(numeric?.[1] === undefined ? [] : [{ number: Number(numeric[1]) }]),
      ],
    });
  }
  return and;
}

export class TenderService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext, query: TenderListQuery): Promise<Page<TenderSummaryView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const now = this.clock();
    const { timeZone } = await organizationToday(this.db, organizationId, now);
    const filter = tenderListWhere(this.db, action.principal, query, now, timeZone);
    if (filter === null) return { items: [], nextCursor: null };
    const size = pageSize(query.limit);
    const and: Prisma.TenderWhereInput[] = [...filter];
    const sort = query.sort ?? 'deadline:asc';
    let orderBy: Prisma.TenderOrderByWithRelationInput[];
    if (sort === 'number:desc') {
      orderBy = [{ number: 'desc' }];
      if (query.cursor !== undefined) {
        const [number = '0'] = decodeCursor(query.cursor, 1);
        and.push({ number: { lt: Number(number) } });
      }
    } else if (sort === 'updatedAt:desc') {
      orderBy = [{ updatedAt: 'desc' }, { id: 'desc' }];
      if (query.cursor !== undefined) {
        const [updatedAt = '', id = ''] = decodeCursor(query.cursor, 2);
        const at = new Date(updatedAt);
        and.push({ OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: id } }] });
      }
    } else {
      orderBy = [{ submissionDeadlineAt: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
      if (query.cursor !== undefined) {
        const [deadline = '', id = ''] = decodeCursor(query.cursor, 2);
        if (deadline === '') {
          and.push({ submissionDeadlineAt: null, id: { gt: id } });
        } else {
          const at = new Date(deadline);
          and.push({
            OR: [
              { submissionDeadlineAt: { gt: at } },
              { submissionDeadlineAt: at, id: { gt: id } },
              { submissionDeadlineAt: null },
            ],
          });
        }
      }
    }
    const rows = await this.db.tender.findMany({
      where: { organizationId, AND: and },
      orderBy,
      take: size + 1,
      select: tenderSummarySelect,
    });
    const page = toPage(rows, size, (row) =>
      sort === 'number:desc'
        ? [String(row.number)]
        : sort === 'updatedAt:desc'
          ? [row.updatedAt.toISOString(), row.id]
          : [row.submissionDeadlineAt?.toISOString() ?? '', row.id],
    );
    return {
      items: page.items.map((row) =>
        toTenderSummary(row, rowFinancialVisible(action.principal, organizationId, row), now),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async get(action: ActionContext, tenderId: string): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    return this.view(this.db, action, organizationId, tender);
  }

  async create(action: ActionContext, input: CreateTenderRequest): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const now = this.clock();
    const status = input.status ?? 'DRAFT';
    validateDeadlines(input);
    if (status === 'NEW' && (input.submissionDeadlineAt ?? null) === null) {
      throw new InvalidInputError('submissionDeadlineAt', 'A new tender needs its submission deadline.');
    }
    if ((input.estimatedValue ?? null) !== null && (input.currency ?? null) === null) {
      throw new InvalidInputError('currency', 'An estimated value needs its currency.');
    }
    const facts = await this.proposedFacts(organizationId, {
      ownerMemberId: input.ownerMemberId,
      technicalLeadMemberId: input.technicalLeadMemberId ?? null,
      commercialLeadMemberId: input.commercialLeadMemberId ?? null,
      relatedProjectId: input.relatedProjectId ?? null,
    });
    if (!canAccessResource(action.principal, 'tender.create', facts)) throw new ForbiddenError();
    if (
      (input.estimatedValue ?? null) !== null &&
      !canAccessResource(action.principal, 'tender.financial.view', facts)
    ) {
      throw new ForbiddenError('You cannot record financial values of this tender.');
    }
    const tenderId = await this.db.$transaction(async (tx) => {
      await this.validateReferences(tx, action, organizationId, {
        customerId: input.customerId ?? null,
        relatedProjectId: input.relatedProjectId ?? null,
        members: [
          ['ownerMemberId', input.ownerMemberId],
          ['technicalLeadMemberId', input.technicalLeadMemberId],
          ['commercialLeadMemberId', input.commercialLeadMemberId],
        ],
      });
      const { today } = await organizationToday(tx, organizationId, now);
      const number = Number(await nextCounterValue(tx, organizationId, 'TND'));
      const created = await tx.tender.create({
        data: {
          organizationId,
          number,
          year: Number(today.slice(0, 4)),
          title: input.title,
          internalReference: input.internalReference ?? null,
          description: input.description ?? null,
          customerId: input.customerId ?? null,
          counterpartyName: input.counterpartyName ?? null,
          relatedProjectId: input.relatedProjectId ?? null,
          tenderType: input.tenderType,
          procurementMethod: input.procurementMethod ?? null,
          publishedAt: toInstant(input.publishedAt),
          submissionDeadlineAt: toInstant(input.submissionDeadlineAt),
          submissionDeadlineTimeZone: input.submissionDeadlineTimeZone ?? null,
          clarificationDeadlineAt: toInstant(input.clarificationDeadlineAt),
          estimatedValue: input.estimatedValue == null ? null : decimal(input.estimatedValue),
          currency: input.currency ?? null,
          status,
          ownerMemberId: input.ownerMemberId,
          technicalLeadMemberId: input.technicalLeadMemberId ?? null,
          commercialLeadMemberId: input.commercialLeadMemberId ?? null,
          priority: input.priority ?? 'MEDIUM',
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true, number: true, year: true },
      });
      if (status !== 'DRAFT') {
        await appendTenderEvent(tx, organizationId, created.id, 'tender.created', action.principal.memberId, {
          key: tenderKey(created.year, created.number),
        });
      }
      await recordAudit(tx, organizationId, {
        action: 'tender.created',
        entityType: 'tender',
        entityId: created.id,
        actor: userActor(action),
        metadata: { status, number: created.number },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'tender', created.id);
      return created.id;
    });
    return this.get(action, tenderId);
  }

  async update(action: ActionContext, tenderId: string, input: UpdateTenderRequest): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.edit');
      const current = await tx.tender.findFirstOrThrow({
        where: { organizationId, id: tenderId },
        select: {
          status: true,
          version: true,
          submissionDeadlineAt: true,
          submissionDeadlineTimeZone: true,
          clarificationDeadlineAt: true,
          publishedAt: true,
          estimatedValue: true,
          currency: true,
          ownerMemberId: true,
          customerId: true,
          relatedProjectId: true,
        },
      });
      if (CLOSED_TENDER_STATUSES.includes(current.status)) {
        throw new InvalidTransitionError('A closed tender cannot be edited.');
      }
      if (current.version !== input.version) throw new VersionConflictError('Tender');
      const changed = Object.keys(input).filter((key) => input[key as keyof UpdateTenderRequest] !== undefined);
      if (SUBMITTED_STATUSES.includes(current.status) && changed.some((key) => !SUBMITTED_EDITABLE_FIELDS.has(key))) {
        throw new InvalidTransitionError('Submitted tenders keep their submission-critical fields.');
      }
      const touchesDeadline =
        input.submissionDeadlineAt !== undefined || input.submissionDeadlineTimeZone !== undefined;
      if (touchesDeadline && !deadlineEditableDirectly(current.status)) {
        throw new InvalidTransitionError('After intake the deadline changes through an addendum.');
      }
      const financialChange = input.estimatedValue !== undefined || input.currency !== undefined;
      if (financialChange && !canViewTenderFinancial(tender)) {
        throw new ForbiddenError('You cannot change financial values of this tender.');
      }
      const merged = {
        publishedAt: input.publishedAt !== undefined ? input.publishedAt : isoOrNull(current.publishedAt),
        submissionDeadlineAt:
          input.submissionDeadlineAt !== undefined
            ? input.submissionDeadlineAt
            : isoOrNull(current.submissionDeadlineAt),
        submissionDeadlineTimeZone:
          input.submissionDeadlineTimeZone !== undefined
            ? input.submissionDeadlineTimeZone
            : current.submissionDeadlineTimeZone,
        clarificationDeadlineAt:
          input.clarificationDeadlineAt !== undefined
            ? input.clarificationDeadlineAt
            : isoOrNull(current.clarificationDeadlineAt),
      };
      validateDeadlines(merged);
      const estimated =
        input.estimatedValue !== undefined ? input.estimatedValue : (current.estimatedValue?.toString() ?? null);
      const currency = input.currency !== undefined ? input.currency : current.currency;
      if (estimated !== null && currency === null) {
        throw new InvalidInputError('currency', 'An estimated value needs its currency.');
      }
      if (
        input.ownerMemberId !== undefined ||
        input.relatedProjectId !== undefined ||
        input.technicalLeadMemberId !== undefined ||
        input.commercialLeadMemberId !== undefined
      ) {
        const next = await tx.tender.findFirstOrThrow({
          where: { organizationId, id: tenderId },
          select: {
            ownerMemberId: true,
            technicalLeadMemberId: true,
            commercialLeadMemberId: true,
            relatedProjectId: true,
          },
        });
        const facts = await this.proposedFacts(
          organizationId,
          {
            ownerMemberId: input.ownerMemberId ?? next.ownerMemberId,
            technicalLeadMemberId:
              input.technicalLeadMemberId !== undefined ? input.technicalLeadMemberId : next.technicalLeadMemberId,
            commercialLeadMemberId:
              input.commercialLeadMemberId !== undefined ? input.commercialLeadMemberId : next.commercialLeadMemberId,
            relatedProjectId: input.relatedProjectId !== undefined ? input.relatedProjectId : next.relatedProjectId,
          },
          tx,
        );
        if (!canAccessResource(action.principal, 'tender.edit', facts)) {
          throw new ForbiddenError('The new owner or project would move the tender outside your scope.');
        }
      }
      await this.validateReferences(tx, action, organizationId, {
        customerId: input.customerId !== undefined && input.customerId !== current.customerId ? input.customerId : null,
        relatedProjectId:
          input.relatedProjectId !== undefined && input.relatedProjectId !== current.relatedProjectId
            ? input.relatedProjectId
            : null,
        members: [
          ['ownerMemberId', input.ownerMemberId],
          ['technicalLeadMemberId', input.technicalLeadMemberId],
          ['commercialLeadMemberId', input.commercialLeadMemberId],
        ],
      });
      const data: Prisma.TenderUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.title !== undefined) data.title = input.title;
      if (input.internalReference !== undefined) data.internalReference = input.internalReference;
      if (input.description !== undefined) data.description = input.description;
      if (input.customerId !== undefined) data.customerId = input.customerId;
      if (input.counterpartyName !== undefined) data.counterpartyName = input.counterpartyName;
      if (input.relatedProjectId !== undefined) data.relatedProjectId = input.relatedProjectId;
      if (input.tenderType !== undefined) data.tenderType = input.tenderType;
      if (input.procurementMethod !== undefined) data.procurementMethod = input.procurementMethod;
      if (input.publishedAt !== undefined) data.publishedAt = toInstant(input.publishedAt);
      if (input.submissionDeadlineAt !== undefined) data.submissionDeadlineAt = toInstant(input.submissionDeadlineAt);
      if (input.submissionDeadlineTimeZone !== undefined)
        data.submissionDeadlineTimeZone = input.submissionDeadlineTimeZone;
      if (input.clarificationDeadlineAt !== undefined)
        data.clarificationDeadlineAt = toInstant(input.clarificationDeadlineAt);
      if (input.estimatedValue !== undefined)
        data.estimatedValue = input.estimatedValue === null ? null : decimal(input.estimatedValue);
      if (input.currency !== undefined) data.currency = input.currency;
      if (input.ownerMemberId !== undefined) data.ownerMemberId = input.ownerMemberId;
      if (input.technicalLeadMemberId !== undefined) data.technicalLeadMemberId = input.technicalLeadMemberId;
      if (input.commercialLeadMemberId !== undefined) data.commercialLeadMemberId = input.commercialLeadMemberId;
      if (input.priority !== undefined) data.priority = input.priority;
      const result = await tx.tender.updateMany({
        where: { organizationId, id: tenderId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Tender');
      const fields = changed.filter((key) => key !== 'version').sort();
      if (current.status !== 'DRAFT') {
        if (input.ownerMemberId !== undefined && input.ownerMemberId !== current.ownerMemberId) {
          await appendTenderEvent(tx, organizationId, tenderId, 'tender.owner_changed', action.principal.memberId, {
            ownerMemberId: input.ownerMemberId,
          });
        }
        if (touchesDeadline) {
          await appendTenderEvent(tx, organizationId, tenderId, 'tender.deadline_changed', action.principal.memberId, {
            previousDeadlineAt: isoOrNull(current.submissionDeadlineAt),
            newDeadlineAt: input.submissionDeadlineAt ?? null,
          });
        }
        if (fields.length > 0) {
          await appendTenderEvent(tx, organizationId, tenderId, 'tender.updated', action.principal.memberId, {
            fields: fields.filter((field) => field !== 'estimatedValue' && field !== 'currency').join(','),
          });
        }
      }
      await recordAudit(tx, organizationId, {
        action: 'tender.updated',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { fields },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.get(action, tenderId);
  }

  /** Draft-only hard delete with `tender.delete_draft`; a draft with any child record is kept. */
  async delete(action: ActionContext, tenderId: string, version: number): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    try {
      await this.db.$transaction(async (tx) => {
        const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
        assertCan(tender, 'tender.delete_draft');
        if (tender.row.status !== 'DRAFT') throw new InvalidTransitionError('Only draft tenders can be deleted.');
        const result = await tx.tender.deleteMany({
          where: { organizationId, id: tenderId, status: 'DRAFT', version },
        });
        if (result.count === 0) throw new VersionConflictError('Tender');
        await recordAudit(tx, organizationId, {
          action: 'tender.deleted',
          entityType: 'tender',
          entityId: tenderId,
          actor: userActor(action),
          metadata: { number: tender.row.number },
          context: action.request,
        });
        await announceCommercialChange(tx, organizationId, 'tender', tenderId);
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictError('The draft already has requirements, documents or guarantees; cancel it instead.');
      }
      throw error;
    }
  }

  async transition(action: ActionContext, tenderId: string, input: TenderTransitionRequest): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      const from = tender.row.status;
      const check = checkManualTransition(from, input.to);
      if (!check.ok) {
        throw new InvalidTransitionError(
          check.reason === 'CONTROLLED'
            ? `${input.to} is reached through its own action, not a status change.`
            : `A tender cannot move from ${from} to ${input.to}.`,
        );
      }
      assertCan(tender, check.permission);
      if (check.needsReason && input.reason === undefined)
        throw new InvalidInputError('reason', 'A reason is required.');
      if (input.to === 'NEW' && tender.row.submissionDeadlineAt === null) {
        throw new InvalidInputError('submissionDeadlineAt', 'Set the submission deadline first.');
      }
      const now = this.clock();
      const data: Prisma.TenderUncheckedUpdateManyInput = { status: input.to, version: { increment: 1 } };
      if (input.to === 'CANCELLED') data.cancelReason = input.reason ?? null;
      if (input.to === 'ARCHIVED') data.archivedAt = now;
      const result = await tx.tender.updateMany({
        where: { organizationId, id: tenderId, status: from, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Tender');
      if (from === 'INTERNAL_REVIEW') await supersedeOpenReviews(tx, organizationId, tenderId, now);
      const key = tenderKey(tender.row.year, tender.row.number);
      if (from === 'DRAFT') {
        await appendTenderEvent(tx, organizationId, tenderId, 'tender.created', action.principal.memberId, { key });
      }
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.status_changed', action.principal.memberId, {
        from,
        to: input.to,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.status_changed',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { from, to: input.to },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.get(action, tenderId);
  }

  async decideBid(action: ActionContext, tenderId: string, input: BidDecisionRequest): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (input.decision === 'NO_BID' && input.noBidReason === undefined) {
      throw new InvalidInputError('noBidReason', 'A no-bid decision needs its reason.');
    }
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.approve');
      const from = tender.row.status;
      if (!BID_DECISION_STATUSES.includes(from)) {
        throw new InvalidTransitionError(`A bid decision cannot be recorded while the tender is ${from}.`);
      }
      const to = statusAfterBidDecision(input.decision);
      const result = await tx.tender.updateMany({
        where: { organizationId, id: tenderId, status: from, version: input.version },
        data: { status: to, bidDecision: input.decision, version: { increment: 1 } },
      });
      if (result.count === 0) throw new VersionConflictError('Tender');
      await tx.tenderBidDecisionRecord.create({
        data: {
          organizationId,
          tenderId,
          decision: input.decision,
          ...input.criteria,
          noBidReason: input.decision === 'NO_BID' ? (input.noBidReason ?? null) : null,
          comments: input.comments ?? null,
          decidedByMemberId: action.principal.memberId,
          tenderVersion: input.version + 1,
        },
        select: { id: true },
      });
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.bid_decided', action.principal.memberId, {
        decision: input.decision,
        ...(input.decision === 'NO_BID' && input.noBidReason !== undefined ? { noBidReason: input.noBidReason } : {}),
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.bid_decided',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { decision: input.decision, from, to },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.get(action, tenderId);
  }

  async listBidDecisions(action: ActionContext, tenderId: string): Promise<BidDecisionView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    if (tender.level !== 'FULL') return [];
    const rows = await this.db.tenderBidDecisionRecord.findMany({
      where: { organizationId, tenderId },
      orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
      take: 50,
      include: { decidedBy: { select: memberRefSelect } },
    });
    return rows.map((row) => ({
      id: row.id,
      decision: row.decision === 'NO_BID' ? 'NO_BID' : 'BID',
      criteria: Object.fromEntries(CRITERIA_KEYS.map((key) => [key, row[key]])),
      noBidReason: row.noBidReason,
      comments: row.comments,
      decidedBy: toPersonRef(row.decidedBy),
      decidedAt: iso(row.decidedAt),
    }));
  }

  /**
   * Controlled submission (spec §24). Requires the Idempotency-Key: a retried request with the same
   * key returns the tender as recorded by the first one instead of submitting twice.
   */
  async submit(
    action: ActionContext,
    tenderId: string,
    input: SubmitTenderRequest,
    idempotencyKey: string,
  ): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const now = this.clock();
    const submittedAt = new Date(input.submittedAt);
    if (submittedAt.getTime() > now.getTime() + 5 * 60_000) {
      throw new InvalidInputError('submittedAt', 'The submission time cannot be in the future.');
    }
    const replay = await this.findSubmission(organizationId, tenderId, idempotencyKey);
    if (replay !== null) return this.get(action, tenderId);
    try {
      await this.db.$transaction(async (tx) => {
        const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
        assertCan(tender, 'tender.submit');
        if (tender.row.status !== 'READY_FOR_SUBMISSION') {
          throw new InvalidTransitionError('Only a tender that is ready for submission can be submitted.');
        }
        if (input.evidenceVersionId != null)
          await assertTenderVersion(tx, organizationId, tender, input.evidenceVersionId, 'evidenceVersionId');
        const result = await tx.tender.updateMany({
          where: { organizationId, id: tenderId, status: 'READY_FOR_SUBMISSION', version: input.version },
          data: {
            status: 'SUBMITTED',
            submittedAt,
            submittedByMemberId: action.principal.memberId,
            submissionMethod: input.method,
            submissionReference: input.reference ?? null,
            version: { increment: 1 },
          },
        });
        if (result.count === 0) throw new VersionConflictError('Tender');
        await tx.tenderSubmission.create({
          data: {
            organizationId,
            tenderId,
            kind: 'SUBMISSION',
            idempotencyKey,
            method: input.method,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            submittedAt,
            submittedByMemberId: action.principal.memberId,
            evidenceVersionId: input.evidenceVersionId ?? null,
            tenderVersion: input.version + 1,
          },
          select: { id: true },
        });
        const key = tenderKey(tender.row.year, tender.row.number);
        await appendTenderEvent(tx, organizationId, tenderId, 'tender.submitted', action.principal.memberId, {
          method: input.method,
          late: tender.row.submissionDeadlineAt !== null && submittedAt > tender.row.submissionDeadlineAt,
        });
        await recordAudit(tx, organizationId, {
          action: 'tender.submitted',
          entityType: 'tender',
          entityId: tenderId,
          actor: userActor(action),
          metadata: { method: input.method, evidence: input.evidenceVersionId != null },
          context: action.request,
        });
        await this.notifyTenderPeople(tx, organizationId, tender, {
          type: 'TENDER_SUBMITTED',
          severity: 'INFO',
          key,
          dedupeKey: `tender_submitted:${tenderId}:${idempotencyKey}`,
          actorMemberId: action.principal.memberId,
        });
        await announceCommercialChange(tx, organizationId, 'tender', tenderId);
      });
    } catch (error) {
      if (isUniqueViolation(error) && (await this.findSubmission(organizationId, tenderId, idempotencyKey)) !== null) {
        return this.get(action, tenderId);
      }
      throw error;
    }
    return this.get(action, tenderId);
  }

  /** Controlled correction of the recorded submission: a new CORRECTION row, never an overwrite. */
  async correctSubmission(
    action: ActionContext,
    tenderId: string,
    input: CorrectSubmissionRequest,
    idempotencyKey: string,
  ): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const now = this.clock();
    const submittedAt = new Date(input.submittedAt);
    if (submittedAt.getTime() > now.getTime() + 5 * 60_000) {
      throw new InvalidInputError('submittedAt', 'The submission time cannot be in the future.');
    }
    if ((await this.findSubmission(organizationId, tenderId, idempotencyKey)) !== null)
      return this.get(action, tenderId);
    try {
      await this.db.$transaction(async (tx) => {
        const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
        assertCan(tender, 'tender.submit');
        if (tender.row.status !== 'SUBMITTED' && tender.row.status !== 'CLARIFICATION') {
          throw new InvalidTransitionError('Only a submitted tender awaiting its outcome can be corrected.');
        }
        const latest = await tx.tenderSubmission.findFirst({
          where: { organizationId, tenderId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (latest === null) throw new InvalidTransitionError('There is no submission to correct.');
        if (input.evidenceVersionId != null)
          await assertTenderVersion(tx, organizationId, tender, input.evidenceVersionId, 'evidenceVersionId');
        const result = await tx.tender.updateMany({
          where: { organizationId, id: tenderId, version: tender.row.version },
          data: {
            submittedAt,
            submissionMethod: input.method,
            submissionReference: input.reference ?? null,
            version: { increment: 1 },
          },
        });
        if (result.count === 0) throw new VersionConflictError('Tender');
        await tx.tenderSubmission.create({
          data: {
            organizationId,
            tenderId,
            kind: 'CORRECTION',
            idempotencyKey,
            method: input.method,
            reference: input.reference ?? null,
            notes: input.notes ?? null,
            submittedAt,
            submittedByMemberId: action.principal.memberId,
            evidenceVersionId: input.evidenceVersionId ?? null,
            correctsSubmissionId: latest.id,
            tenderVersion: tender.row.version + 1,
          },
          select: { id: true },
        });
        await appendTenderEvent(
          tx,
          organizationId,
          tenderId,
          'tender.submission_corrected',
          action.principal.memberId,
          {
            reason: input.reason,
          },
        );
        await recordAudit(tx, organizationId, {
          action: 'tender.submission_corrected',
          entityType: 'tender',
          entityId: tenderId,
          actor: userActor(action),
          metadata: { correctsSubmissionId: latest.id, method: input.method },
          context: action.request,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error) && (await this.findSubmission(organizationId, tenderId, idempotencyKey)) !== null) {
        return this.get(action, tenderId);
      }
      throw error;
    }
    return this.get(action, tenderId);
  }

  async listSubmissions(action: ActionContext, tenderId: string): Promise<TenderSubmissionView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    if (tender.level !== 'FULL') return [];
    const rows = await this.db.tenderSubmission.findMany({
      where: { organizationId, tenderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
      include: {
        submittedBy: { select: memberRefSelect },
        evidenceVersion: {
          select: {
            id: true,
            versionNumber: true,
            document: { select: { id: true, title: true, classification: true } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      method: row.method,
      reference: row.reference,
      notes: row.notes,
      submittedAt: iso(row.submittedAt),
      submittedBy: toPersonRef(row.submittedBy),
      evidence:
        row.evidenceVersion === null ||
        !canViewCommercialDocument(tender, 'tender.financial.view', row.evidenceVersion.document.classification)
          ? null
          : {
              documentId: row.evidenceVersion.document.id,
              versionId: row.evidenceVersion.id,
              title: row.evidenceVersion.document.title,
              versionNumber: row.evidenceVersion.versionNumber,
            },
      correctsSubmissionId: row.correctsSubmissionId,
      createdAt: iso(row.createdAt),
    }));
  }

  async recordAward(action: ActionContext, tenderId: string, input: RecordAwardRequest): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.record_award');
      if (tender.row.status === 'AWARDED') {
        const current = await tx.tender.findFirstOrThrow({
          where: { organizationId, id: tenderId },
          select: { awardDate: true },
        });
        if (dateOnly(current.awardDate) === input.awardDate) return;
      }
      if (tender.row.status !== 'SUBMITTED' && tender.row.status !== 'CLARIFICATION') {
        throw new InvalidTransitionError('An award is recorded for a submitted tender.');
      }
      if (input.awardValue != null && !canViewTenderFinancial(tender)) {
        throw new ForbiddenError('You cannot record financial values of this tender.');
      }
      const tenderCurrency = await tx.tender.findFirstOrThrow({
        where: { organizationId, id: tenderId },
        select: { currency: true },
      });
      const awardCurrency = input.awardValue == null ? null : (input.awardCurrency ?? tenderCurrency.currency);
      if (input.awardValue != null && awardCurrency === null) {
        throw new InvalidInputError('awardCurrency', 'An award value needs its currency.');
      }
      const result = await tx.tender.updateMany({
        where: { organizationId, id: tenderId, status: tender.row.status, version: input.version },
        data: {
          status: 'AWARDED',
          awardDate: new Date(`${input.awardDate}T00:00:00.000Z`),
          awardValue: input.awardValue == null ? null : decimal(input.awardValue),
          awardCurrency,
          awardReference: input.awardReference ?? null,
          awardNotes: input.awardNotes ?? null,
          version: { increment: 1 },
        },
      });
      if (result.count === 0) throw new VersionConflictError('Tender');
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.awarded', action.principal.memberId, {
        awardDate: input.awardDate,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.awarded',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { awardDate: input.awardDate, valueRecorded: input.awardValue != null },
        context: action.request,
      });
      await this.notifyTenderPeople(tx, organizationId, tender, {
        type: 'TENDER_AWARDED',
        severity: 'INFO',
        key: tenderKey(tender.row.year, tender.row.number),
        dedupeKey: `tender_awarded:${tenderId}`,
        actorMemberId: action.principal.memberId,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.get(action, tenderId);
  }

  async recordLoss(action: ActionContext, tenderId: string, input: RecordLossRequest): Promise<TenderView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.record_loss');
      const current = await tx.tender.findFirstOrThrow({
        where: { organizationId, id: tenderId },
        select: { lossReason: true, currency: true },
      });
      if (tender.row.status === 'LOST' && current.lossReason === input.lossReason) return;
      if (tender.row.status !== 'SUBMITTED' && tender.row.status !== 'CLARIFICATION') {
        throw new InvalidTransitionError('A loss is recorded for a submitted tender.');
      }
      const hasValues = input.winningValue != null || input.ourSubmittedValue != null;
      if (hasValues && !canViewTenderFinancial(tender)) {
        throw new ForbiddenError('You cannot record financial values of this tender.');
      }
      if (hasValues && current.currency === null) {
        throw new InvalidInputError('currency', 'Set the tender currency before recording values.');
      }
      const result = await tx.tender.updateMany({
        where: { organizationId, id: tenderId, status: tender.row.status, version: input.version },
        data: {
          status: 'LOST',
          lossReason: input.lossReason,
          winningCompany: input.winningCompany ?? null,
          winningValue: input.winningValue == null ? null : decimal(input.winningValue),
          ourSubmittedValue: input.ourSubmittedValue == null ? null : decimal(input.ourSubmittedValue),
          debriefNotes: input.debriefNotes ?? null,
          lessonsLearned: input.lessonsLearned ?? null,
          version: { increment: 1 },
        },
      });
      if (result.count === 0) throw new VersionConflictError('Tender');
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.loss_recorded', action.principal.memberId, {
        lossReason: input.lossReason,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.lost',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { lossReason: input.lossReason },
        context: action.request,
      });
      await this.notifyTenderPeople(tx, organizationId, tender, {
        type: 'TENDER_LOST',
        severity: 'INFO',
        key: tenderKey(tender.row.year, tender.row.number),
        dedupeKey: `tender_lost:${tenderId}`,
        actorMemberId: action.principal.memberId,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.get(action, tenderId);
  }

  /** Addendum (spec §21): a deadline change keeps the previous deadline on the addendum row. */
  async createAddendum(
    action: ActionContext,
    tenderId: string,
    input: CreateAddendumRequest,
  ): Promise<TenderAddendumView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (input.newTimeZone != null) assertTimeZone('newTimeZone', input.newTimeZone);
    const id = await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.edit');
      if (!isOpenForWork(tender.row.status) || tender.row.status === 'SUBMITTED') {
        throw new InvalidTransitionError('Addenda are recorded before the outcome of the tender.');
      }
      if (input.documentVersionId != null)
        await assertTenderVersion(tx, organizationId, tender, input.documentVersionId, 'documentVersionId');
      const current = await tx.tender.findFirstOrThrow({
        where: { organizationId, id: tenderId },
        select: {
          submissionDeadlineAt: true,
          submissionDeadlineTimeZone: true,
          clarificationDeadlineAt: true,
          publishedAt: true,
          addendumSeq: true,
        },
      });
      const newDeadline = input.newDeadlineAt == null ? null : new Date(input.newDeadlineAt);
      if (newDeadline !== null) {
        if (current.publishedAt !== null && newDeadline < current.publishedAt) {
          throw new InvalidInputError('newDeadlineAt', 'The deadline cannot precede the publication date.');
        }
        if (current.clarificationDeadlineAt !== null && newDeadline < current.clarificationDeadlineAt) {
          throw new InvalidInputError('newDeadlineAt', 'The deadline cannot precede the clarification deadline.');
        }
      }
      const data: Prisma.TenderUncheckedUpdateManyInput = { addendumSeq: { increment: 1 }, version: { increment: 1 } };
      if (newDeadline !== null) {
        data.submissionDeadlineAt = newDeadline;
        data.submissionDeadlineTimeZone = input.newTimeZone ?? null;
      }
      const result = await tx.tender.updateMany({
        where: { organizationId, id: tenderId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Tender');
      const number = current.addendumSeq + 1;
      const created = await tx.tenderAddendum.create({
        data: {
          organizationId,
          tenderId,
          number,
          reference: input.reference ?? null,
          summary: input.summary,
          receivedAt: new Date(input.receivedAt),
          documentVersionId: input.documentVersionId ?? null,
          previousDeadlineAt: newDeadline === null ? null : current.submissionDeadlineAt,
          previousTimeZone: newDeadline === null ? null : current.submissionDeadlineTimeZone,
          newDeadlineAt: newDeadline,
          newTimeZone: newDeadline === null ? null : (input.newTimeZone ?? null),
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true },
      });
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.addendum_recorded', action.principal.memberId, {
        number,
      });
      if (newDeadline !== null) {
        await appendTenderEvent(tx, organizationId, tenderId, 'tender.deadline_changed', action.principal.memberId, {
          previousDeadlineAt: isoOrNull(current.submissionDeadlineAt),
          newDeadlineAt: newDeadline.toISOString(),
          addendum: number,
        });
      }
      await recordAudit(tx, organizationId, {
        action: 'tender.addendum_recorded',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { number, deadlineChanged: newDeadline !== null },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
      return created.id;
    });
    const all = await this.listAddenda(action, tenderId);
    const created = all.find((addendum) => addendum.id === id);
    if (created === undefined) throw new NotFoundError('Addendum');
    return created;
  }

  async listAddenda(action: ActionContext, tenderId: string): Promise<TenderAddendumView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    const rows = await this.db.tenderAddendum.findMany({
      where: { organizationId, tenderId },
      orderBy: { number: 'asc' },
      take: 200,
      include: { createdBy: { select: memberRefSelect }, documentVersion: versionClassificationSelect },
    });
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      reference: row.reference,
      summary: row.summary,
      receivedAt: iso(row.receivedAt),
      documentVersionId: visibleVersionId(tender, 'tender.financial.view', row.documentVersion),
      previousDeadlineAt: isoOrNull(row.previousDeadlineAt),
      previousTimeZone: row.previousTimeZone,
      newDeadlineAt: isoOrNull(row.newDeadlineAt),
      newTimeZone: row.newTimeZone,
      createdBy: toPersonRef(row.createdBy),
      createdAt: iso(row.createdAt),
    }));
  }

  async createClarification(
    action: ActionContext,
    tenderId: string,
    input: CreateClarificationRequest,
  ): Promise<TenderClarificationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.edit');
      if (!isOpenForWork(tender.row.status)) throw new InvalidTransitionError('The tender is closed.');
      const created = await tx.tenderClarification.create({
        data: {
          organizationId,
          tenderId,
          question: input.question,
          reference: input.reference ?? null,
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true },
      });
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.clarification_opened', action.principal.memberId, {
        clarificationId: created.id,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.clarification_created',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { clarificationId: created.id },
        context: action.request,
      });
      return created.id;
    });
    return this.loadClarification(organizationId, tenderId, id);
  }

  async updateClarification(
    action: ActionContext,
    tenderId: string,
    clarificationId: string,
    input: UpdateClarificationRequest,
  ): Promise<TenderClarificationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      assertCan(tender, 'tender.edit');
      const current = await tx.tenderClarification.findFirst({
        where: { organizationId, tenderId, id: clarificationId },
        select: { status: true, version: true },
      });
      if (current === null) throw new NotFoundError('Clarification');
      const allowed: Record<string, readonly string[]> = {
        OPEN: ['SUBMITTED', 'WITHDRAWN'],
        SUBMITTED: ['ANSWERED', 'WITHDRAWN'],
        ANSWERED: [],
        WITHDRAWN: [],
      };
      if (!(allowed[current.status] ?? []).includes(input.status)) {
        throw new InvalidTransitionError(`A clarification cannot move from ${current.status} to ${input.status}.`);
      }
      if (input.status === 'ANSWERED' && (input.response ?? null) === null) {
        throw new InvalidInputError('response', 'Record the response.');
      }
      const now = this.clock();
      const result = await tx.tenderClarification.updateMany({
        where: { organizationId, tenderId, id: clarificationId, version: input.version },
        data: {
          status: input.status,
          ...(input.status === 'SUBMITTED' ? { submittedAt: now } : {}),
          ...(input.status === 'ANSWERED' ? { response: input.response ?? null, respondedAt: now } : {}),
          version: { increment: 1 },
        },
      });
      if (result.count === 0) throw new VersionConflictError('Clarification');
      await appendTenderEvent(
        tx,
        organizationId,
        tenderId,
        `tender.clarification_${input.status.toLowerCase()}`,
        action.principal.memberId,
        {
          clarificationId,
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'tender.clarification_updated',
        entityType: 'tender',
        entityId: tenderId,
        actor: userActor(action),
        metadata: { clarificationId, status: input.status },
        context: action.request,
      });
    });
    return this.loadClarification(organizationId, tenderId, clarificationId);
  }

  async listClarifications(action: ActionContext, tenderId: string): Promise<TenderClarificationView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await loadVisibleTender(this.db, action, organizationId, tenderId);
    const rows = await this.db.tenderClarification.findMany({
      where: { organizationId, tenderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 200,
      include: { createdBy: { select: memberRefSelect } },
    });
    return rows.map(toClarificationView);
  }

  async timeline(
    action: ActionContext,
    tenderId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<Page<CommercialEventView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    const size = pageSize(limit);
    const and: Prisma.TenderEventWhereInput[] = [];
    const hidden = await hiddenDocumentEventsWhere(this.db, organizationId, { type: 'TENDER', loaded: tender });
    if (hidden !== null) and.push(hidden);
    if (cursor !== undefined) {
      const [createdAt = '', id = ''] = decodeCursor(cursor, 2);
      const at = new Date(createdAt);
      and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.tenderEvent.findMany({
      where: { organizationId, tenderId, AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      include: { actor: { select: memberRefSelect } },
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    const financial = canViewTenderFinancial(tender);
    return {
      items: page.items.map((row) => ({
        id: row.id,
        type: row.type,
        actor: personOrNull(row.actor),
        params: eventParams(row.metadata, financial),
        createdAt: iso(row.createdAt),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Whether a member may still open a tender (notification email re-check). */
  async memberCanView(organizationId: string, principal: Principal, tenderId: string): Promise<boolean> {
    return (await loadTenderForAccess(this.db, principal, organizationId, tenderId)) !== null;
  }

  // ---- internals ----

  private async view(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    tender: LoadedTender,
  ): Promise<TenderView> {
    const now = this.clock();
    const row = await db.tender.findFirstOrThrow({
      where: { organizationId, id: tender.row.id },
      select: tenderDetailSelect,
    });
    const { today } = await organizationToday(db, organizationId, now);
    const requirements = await db.tenderRequirement.findMany({
      where: { organizationId, tenderId: row.id },
      select: { status: true, mandatory: true, ownerMemberId: true, dueDate: true },
    });
    const facts: RequirementFacts[] = requirements.map((r) => ({ ...r, dueDate: dateOnly(r.dueDate) }));
    const financial = canViewTenderFinancial(tender);
    const summary = toTenderSummary(row, financial, now, { requirements: facts, today });
    const contractWhere = visibleContractWhere(action.principal);
    const contracts =
      contractWhere === null
        ? []
        : await db.contract.findMany({
            where: { organizationId, sourceTenderId: row.id, AND: [contractWhere] },
            orderBy: { number: 'asc' },
            take: 20,
            select: { id: true, number: true, year: true, title: true, status: true },
          });
    const pendingReviews = await db.tenderReview.count({
      where: { organizationId, tenderId: row.id, status: 'PENDING', gate: { status: 'OPEN' } },
    });
    const full = tender.level === 'FULL';
    const can = (permission: Parameters<LoadedTender['can']>[0]): boolean => full && tender.can(permission);
    const open = !CLOSED_TENDER_STATUSES.includes(row.status);
    const awardValue = financial ? toMoney(row.awardValue, row.awardCurrency) : undefined;
    const award =
      row.awardDate === null
        ? null
        : {
            awardDate: row.awardDate.toISOString().slice(0, 10),
            reference: row.awardReference,
            notes: row.awardNotes,
            ...(awardValue === undefined ? {} : { value: awardValue }),
          };
    const winning = financial ? toMoney(row.winningValue, row.currency) : undefined;
    const ours = financial ? toMoney(row.ourSubmittedValue, row.currency) : undefined;
    return {
      ...summary,
      accessLevel: tender.level,
      internalReference: row.internalReference,
      description: row.description,
      relatedProject: row.relatedProject,
      tenderType: row.tenderType,
      procurementMethod: row.procurementMethod,
      publishedAt: isoOrNull(row.publishedAt),
      clarificationDeadlineAt: isoOrNull(row.clarificationDeadlineAt),
      technicalLead: personOrNull(row.technicalLead),
      commercialLead: personOrNull(row.commercialLead),
      submission:
        row.submittedAt === null || row.submissionMethod === null
          ? null
          : {
              method: row.submissionMethod,
              reference: row.submissionReference,
              submittedAt: iso(row.submittedAt),
              submittedBy: personOrNull(row.submittedBy),
            },
      award,
      loss:
        row.lossReason === null
          ? null
          : {
              reason: row.lossReason,
              winningCompany: row.winningCompany,
              debriefNotes: row.debriefNotes,
              lessonsLearned: row.lessonsLearned,
              ...(winning === undefined ? {} : { winningValue: winning }),
              ...(ours === undefined ? {} : { ourSubmittedValue: ours }),
            },
      cancelReason: row.cancelReason,
      reviewRound: row.reviewRound,
      archivedAt: isoOrNull(row.archivedAt),
      createdAt: iso(row.createdAt),
      createdBy: personOrNull(row.createdBy),
      contracts: contracts.map((contract) => ({
        id: contract.id,
        key: contractKey(contract.year, contract.number),
        title: contract.title,
        status: contract.status,
      })),
      pendingReviews,
      access: {
        canEdit: open && can('tender.edit'),
        canDelete: row.status === 'DRAFT' && can('tender.delete_draft'),
        canManageRequirements: requirementsEditable(row.status) && can('tender.manage_requirements'),
        canDecideBid: BID_DECISION_STATUSES.includes(row.status) && can('tender.approve'),
        canRequestReview: row.status === 'PREPARING' && can('tender.edit') && readinessState(row) !== 'NOT_READY',
        canSubmit: row.status === 'READY_FOR_SUBMISSION' && can('tender.submit'),
        canRecordAward: (row.status === 'SUBMITTED' || row.status === 'CLARIFICATION') && can('tender.record_award'),
        canRecordLoss: (row.status === 'SUBMITTED' || row.status === 'CLARIFICATION') && can('tender.record_loss'),
        canCreateContract:
          row.status === 'AWARDED' && full && hasPermission(action.principal.permissions, 'contract.create'),
        canManageDocuments: row.status !== 'ARCHIVED' && row.status !== 'CANCELLED' && can('tender.edit'),
        canViewFinancial: financial,
        canViewConfidentialDocuments: can('commercial_document.view'),
        canManageGuarantees: open && can('tender.edit'),
        transitions: manualTargets(row.status).filter(
          (to) => can('tender.edit') && (to !== 'NEW' || row.submissionDeadlineAt !== null),
        ),
      },
    };
  }

  private async proposedFacts(
    organizationId: string,
    proposed: {
      ownerMemberId: string;
      technicalLeadMemberId: string | null;
      commercialLeadMemberId: string | null;
      relatedProjectId: string | null;
    },
    db: TenantDb = this.db,
  ): Promise<ResourceFacts> {
    const owner = await db.organizationMember.findFirst({
      where: { organizationId, id: proposed.ownerMemberId },
      select: { profile: { select: { departmentId: true } } },
    });
    const members = [proposed.ownerMemberId, proposed.technicalLeadMemberId, proposed.commercialLeadMemberId].filter(
      (id): id is string => id !== null,
    );
    const department = owner?.profile?.departmentId ?? null;
    return {
      organizationId,
      ownerMemberIds: members,
      subjectMemberIds: members,
      departmentIds: department === null ? [] : [department],
      projectIds: proposed.relatedProjectId === null ? [] : [proposed.relatedProjectId],
    };
  }

  private async validateReferences(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    refs: {
      customerId: string | null;
      relatedProjectId: string | null;
      members: readonly (readonly [string, string | null | undefined])[];
    },
  ): Promise<void> {
    if (refs.customerId !== null) {
      const customer = await tx.customer.findFirst({
        where: { organizationId, id: refs.customerId },
        select: { archivedAt: true },
      });
      if (customer === null) throw new InvalidInputError('customerId', 'Unknown customer.');
      if (customer.archivedAt !== null) throw new InvalidInputError('customerId', 'The customer is archived.');
    }
    if (refs.relatedProjectId !== null) {
      const project = await loadProjectForAccess(tx, organizationId, refs.relatedProjectId);
      if (project === null || !canAccessResource(action.principal, 'project.view', project.facts)) {
        throw new InvalidInputError('relatedProjectId', 'Unknown project.');
      }
    }
    await assertActiveMembers(tx, organizationId, refs.members);
  }

  private async findSubmission(
    organizationId: string,
    tenderId: string,
    idempotencyKey: string,
  ): Promise<{ id: string } | null> {
    return this.db.tenderSubmission.findFirst({
      where: { organizationId, tenderId, idempotencyKey },
      select: { id: true },
    });
  }

  private async loadClarification(
    organizationId: string,
    tenderId: string,
    id: string,
  ): Promise<TenderClarificationView> {
    const row = await this.db.tenderClarification.findFirst({
      where: { organizationId, tenderId, id },
      include: { createdBy: { select: memberRefSelect } },
    });
    if (row === null) throw new NotFoundError('Clarification');
    return toClarificationView(row);
  }

  private async notifyTenderPeople(
    tx: TenantDb,
    organizationId: string,
    tender: LoadedTender,
    notification: {
      type: string;
      severity: 'INFO' | 'WARNING' | 'CRITICAL';
      key: string;
      dedupeKey: string;
      actorMemberId: string;
    },
  ): Promise<void> {
    await notifyMembers(
      tx,
      organizationId,
      [tender.row.ownerMemberId, tender.row.technicalLeadMemberId, tender.row.commercialLeadMemberId],
      {
        type: notification.type,
        severity: notification.severity,
        entityType: 'tender',
        entityId: tender.row.id,
        params: { tenderKey: notification.key, tenderTitle: tender.row.title },
        dedupeKey: notification.dedupeKey,
      },
      async (principal) => (await loadTenderForAccess(tx, principal, organizationId, tender.row.id)) !== null,
      notification.actorMemberId,
    );
  }
}

function toInstant(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(value);
}

/** §65: deadline needs its zone; clarification <= submission deadline; publication <= deadline. */
function validateDeadlines(input: {
  publishedAt?: string | null | undefined;
  submissionDeadlineAt?: string | null | undefined;
  submissionDeadlineTimeZone?: string | null | undefined;
  clarificationDeadlineAt?: string | null | undefined;
}): void {
  const deadline = input.submissionDeadlineAt ?? null;
  if (input.submissionDeadlineTimeZone != null)
    assertTimeZone('submissionDeadlineTimeZone', input.submissionDeadlineTimeZone);
  if ((deadline === null) !== ((input.submissionDeadlineTimeZone ?? null) === null)) {
    throw new InvalidInputError('submissionDeadlineTimeZone', 'The deadline and its time zone are set together.');
  }
  if (deadline === null) return;
  if (input.clarificationDeadlineAt != null && new Date(input.clarificationDeadlineAt) > new Date(deadline)) {
    throw new InvalidInputError(
      'clarificationDeadlineAt',
      'The clarification deadline cannot be after the submission deadline.',
    );
  }
  if (input.publishedAt != null && new Date(input.publishedAt) > new Date(deadline)) {
    throw new InvalidInputError('submissionDeadlineAt', 'The deadline cannot precede the publication date.');
  }
}

async function assertTenderVersion(
  tx: TenantDb,
  organizationId: string,
  tender: LoadedTender,
  versionId: string,
  field: 'evidenceVersionId' | 'documentVersionId',
): Promise<void> {
  const version = await tx.commercialDocumentVersion.findFirst({
    where: {
      organizationId,
      id: versionId,
      document: { tenderId: tender.row.id, ...visibleDocumentWhere(tender, 'tender.financial.view') },
    },
    select: { id: true },
  });
  if (version === null) throw new InvalidInputError(field, 'The document version does not belong to this tender.');
}

/** Withdrawing a review (or returning to preparation) closes every open gate of the round. */
export async function supersedeOpenReviews(
  tx: TenantDb,
  organizationId: string,
  tenderId: string,
  now: Date,
): Promise<void> {
  await tx.tenderReview.updateMany({
    where: { organizationId, tenderId, status: 'PENDING' },
    data: { status: 'SUPERSEDED' },
  });
  await tx.tenderReviewGate.updateMany({
    where: { organizationId, tenderId, status: { in: ['WAITING', 'OPEN'] } },
    data: { status: 'SUPERSEDED', closedAt: now },
  });
}

function toClarificationView(
  row: Prisma.TenderClarificationGetPayload<{ include: { createdBy: { select: typeof memberRefSelect } } }>,
): TenderClarificationView {
  return {
    id: row.id,
    question: row.question,
    reference: row.reference,
    status: row.status,
    submittedAt: isoOrNull(row.submittedAt),
    response: row.response,
    respondedAt: isoOrNull(row.respondedAt),
    createdBy: toPersonRef(row.createdBy),
    createdAt: iso(row.createdAt),
    version: row.version,
  };
}
