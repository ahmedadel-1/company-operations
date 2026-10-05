import type { Prisma, TenderRequirementStatus } from '@company-ops/db';
import type {
  CreateRequirementLinkRequest,
  CreateRequirementRequest,
  RequirementListQuery,
  RequirementStatusRequest,
  TenderWorkQuery,
  UpdateRequirementRequest,
} from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockCommercialAggregate } from '../../platform/db/sql/locks.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import type { OwnerAccess } from '../attachments/attachment.service.js';
import type { Principal } from '../authorization/policy.js';
import { localToday } from '../projects/business-date.js';
import {
  canViewCommercialDocument,
  canViewCorporate,
  corporateAccessSelect,
  corporateFacts,
  fullTenderWhere,
  loadTenderForAccess,
  loadVisibleTender,
} from './commercial-access.js';
import type { LoadedTender } from './commercial-access.js';
import {
  announceCommercialChange,
  appendTenderEvent,
  assertActiveMembers,
  dateOnly,
  iso,
  isoOrNull,
  memberRefSelect,
  notifyMembers,
  organizationToday,
  personOrNull,
} from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { validOn } from './engine/dates.js';
import { isRequirementOverdue, readinessCounters, requirementTransitionAllowed } from './engine/readiness.js';
import type { RequirementActor } from './engine/readiness.js';
import { tenderKey } from './engine/tender-state.js';
import { requirementsEditable } from './tender.service.js';
import { tenderRefSelect, toTenderRef } from './tender-views.js';

export interface RequirementLinkView {
  readonly id: string;
  readonly kind: 'CORPORATE' | 'COMMERCIAL';
  readonly note: string | null;
  readonly createdAt: string;
  readonly createdBy: PersonRef | null;
  readonly document: {
    readonly documentId: string;
    readonly versionId: string;
    readonly title: string;
    readonly type: string;
    readonly versionNumber: number;
    readonly attachmentId: string;
    readonly expiryDate: string | null;
    readonly validOnDeadline: boolean | null;
    readonly isCurrentVersion: boolean;
  };
}

export interface TenderRequirementView {
  readonly id: string;
  readonly tenderId: string;
  readonly category: RequirementRow['category'];
  readonly title: string;
  readonly description: string | null;
  readonly referenceSection: string | null;
  readonly owner: PersonRef | null;
  readonly reviewer: PersonRef | null;
  readonly dueDate: string | null;
  readonly priority: RequirementRow['priority'];
  readonly mandatory: boolean;
  readonly status: TenderRequirementStatus;
  readonly overdue: boolean;
  readonly notes: string | null;
  readonly reviewedBy: PersonRef | null;
  readonly reviewedAt: string | null;
  readonly links: RequirementLinkView[];
  readonly version: number;
  readonly access: {
    readonly canEdit: boolean;
    readonly canWork: boolean;
    readonly canReview: boolean;
    readonly canLink: boolean;
  };
}

type WorkBucket = 'OVERDUE' | 'DUE_TODAY' | 'UPCOMING' | 'BLOCKED' | 'REVIEW' | 'UNASSIGNED' | 'NO_DUE_DATE';

export interface TenderWorkView {
  readonly today: string;
  readonly items: {
    readonly requirement: {
      readonly id: string;
      readonly title: string;
      readonly category: RequirementRow['category'];
      readonly status: TenderRequirementStatus;
      readonly mandatory: boolean;
      readonly dueDate: string | null;
      readonly overdue: boolean;
      readonly priority: RequirementRow['priority'];
      readonly owner: PersonRef | null;
      readonly reviewer: PersonRef | null;
    };
    readonly tender: {
      readonly id: string;
      readonly key: string;
      readonly title: string;
      readonly status: LoadedTender['row']['status'];
      readonly submissionDeadlineAt: string | null;
    };
    readonly bucket: WorkBucket;
  }[];
  readonly reviews: {
    readonly reviewId: string;
    readonly gate: 'TECHNICAL' | 'COMMERCIAL' | 'LEGAL' | 'FINAL';
    readonly tender: ReturnType<typeof toTenderRef>;
    readonly requestedAt: string;
  }[];
  readonly truncated: boolean;
}

const requirementSelect = {
  id: true,
  tenderId: true,
  category: true,
  title: true,
  description: true,
  referenceSection: true,
  ownerMemberId: true,
  reviewerMemberId: true,
  dueDate: true,
  priority: true,
  mandatory: true,
  status: true,
  notes: true,
  reviewedAt: true,
  version: true,
  owner: { select: memberRefSelect },
  reviewer: { select: memberRefSelect },
  reviewedBy: { select: memberRefSelect },
  links: {
    where: { removedAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      note: true,
      createdAt: true,
      createdBy: { select: memberRefSelect },
      corporateDocumentVersion: {
        select: {
          id: true,
          versionNumber: true,
          attachmentId: true,
          validFrom: true,
          expiryDate: true,
          document: { select: { ...corporateAccessSelect, title: true, documentType: true, currentVersion: true } },
        },
      },
      commercialDocumentVersion: {
        select: {
          id: true,
          versionNumber: true,
          attachmentId: true,
          document: { select: { id: true, title: true, category: true, classification: true, currentVersion: true } },
        },
      },
    },
  },
} satisfies Prisma.TenderRequirementSelect;
type RequirementRow = Prisma.TenderRequirementGetPayload<{ select: typeof requirementSelect }>;

const OPEN_REQUIREMENT: Prisma.TenderRequirementWhereInput = { status: { notIn: ['APPROVED', 'NOT_APPLICABLE'] } };
const WORK_LIMIT = 200;
const DAY_MS = 86_400_000;

/**
 * Tender compliance matrix (spec §15-§18): requirements with owner, reviewer and due date; status
 * work by owners and decisions by reviewers; links to specific document versions; "My tender work"
 * and the manager queues. Every change recomputes the tender's stored readiness counters in the same
 * transaction under the tender's aggregate lock (the one readiness formula, `engine/readiness.ts`).
 */
export class TenderRequirementService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext, tenderId: string, query: RequirementListQuery): Promise<TenderRequirementView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    const me = action.principal.memberId;
    const and: Prisma.TenderRequirementWhereInput[] = [];
    if (query.status !== undefined) and.push({ status: { in: [...query.status] } });
    if (query.mine === true || tender.level !== 'FULL') {
      and.push({ OR: [{ ownerMemberId: me }, { reviewerMemberId: me }] });
    }
    const rows = await this.db.tenderRequirement.findMany({
      where: { organizationId, tenderId, AND: and },
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: requirementSelect,
    });
    const context = await this.viewContext(this.db, action, organizationId, tender);
    return rows.map((row) => this.toView(row, tender, context));
  }

  async get(action: ActionContext, tenderId: string, requirementId: string): Promise<TenderRequirementView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    const row = await this.db.tenderRequirement.findFirst({
      where: { organizationId, tenderId, id: requirementId },
      select: requirementSelect,
    });
    if (row === null || !this.mayRead(tender, row, action.principal.memberId)) throw new NotFoundError('Requirement');
    return this.toView(row, tender, await this.viewContext(this.db, action, organizationId, tender));
  }

  async create(
    action: ActionContext,
    tenderId: string,
    input: CreateRequirementRequest,
  ): Promise<TenderRequirementView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const tender = await this.loadForChange(tx, action, organizationId, tenderId);
      this.assertManager(tender);
      await assertActiveMembers(tx, organizationId, [
        ['ownerMemberId', input.ownerMemberId],
        ['reviewerMemberId', input.reviewerMemberId],
      ]);
      const created = await tx.tenderRequirement.create({
        data: {
          organizationId,
          tenderId,
          category: input.category,
          title: input.title,
          description: input.description ?? null,
          referenceSection: input.referenceSection ?? null,
          ownerMemberId: input.ownerMemberId ?? null,
          reviewerMemberId: input.reviewerMemberId ?? null,
          dueDate: toDate(input.dueDate),
          priority: input.priority ?? 'MEDIUM',
          mandatory: input.mandatory ?? true,
          notes: input.notes ?? null,
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true },
      });
      await recomputeTenderReadiness(tx, organizationId, tenderId);
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.requirement_added', action.principal.memberId, {
        requirementId: created.id,
        title: input.title,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.requirement_created',
        entityType: 'tender_requirement',
        entityId: created.id,
        actor: userActor(action),
        metadata: { tenderId, mandatory: input.mandatory ?? true },
        context: action.request,
      });
      if (input.ownerMemberId != null) {
        await this.notifyAssigned(
          tx,
          organizationId,
          tender,
          created.id,
          input.title,
          input.ownerMemberId,
          action.principal.memberId,
        );
      }
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
      return created.id;
    });
    return this.get(action, tenderId, id);
  }

  async update(
    action: ActionContext,
    tenderId: string,
    requirementId: string,
    input: UpdateRequirementRequest,
  ): Promise<TenderRequirementView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await this.loadForChange(tx, action, organizationId, tenderId);
      this.assertManager(tender);
      const current = await tx.tenderRequirement.findFirst({
        where: { organizationId, tenderId, id: requirementId },
        select: { title: true, ownerMemberId: true, reviewerMemberId: true, mandatory: true },
      });
      if (current === null) throw new NotFoundError('Requirement');
      await assertActiveMembers(tx, organizationId, [
        ['ownerMemberId', input.ownerMemberId],
        ['reviewerMemberId', input.reviewerMemberId],
      ]);
      const data: Prisma.TenderRequirementUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.category !== undefined) data.category = input.category;
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.referenceSection !== undefined) data.referenceSection = input.referenceSection;
      if (input.ownerMemberId !== undefined) data.ownerMemberId = input.ownerMemberId;
      if (input.reviewerMemberId !== undefined) data.reviewerMemberId = input.reviewerMemberId;
      if (input.dueDate !== undefined) data.dueDate = toDate(input.dueDate);
      if (input.priority !== undefined) data.priority = input.priority;
      if (input.mandatory !== undefined) data.mandatory = input.mandatory;
      if (input.notes !== undefined) data.notes = input.notes;
      const result = await tx.tenderRequirement.updateMany({
        where: { organizationId, tenderId, id: requirementId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Requirement');
      await recomputeTenderReadiness(tx, organizationId, tenderId);
      const ownerChanged = input.ownerMemberId !== undefined && input.ownerMemberId !== current.ownerMemberId;
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.requirement_updated', action.principal.memberId, {
        requirementId,
        title: input.title ?? current.title,
        ownerChanged,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.requirement_updated',
        entityType: 'tender_requirement',
        entityId: requirementId,
        actor: userActor(action),
        metadata: { tenderId, fields: Object.keys(input).filter((key) => key !== 'version'), ownerChanged },
        context: action.request,
      });
      if (ownerChanged && input.ownerMemberId != null) {
        await this.notifyAssigned(
          tx,
          organizationId,
          tender,
          requirementId,
          input.title ?? current.title,
          input.ownerMemberId,
          action.principal.memberId,
        );
      }
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.get(action, tenderId, requirementId);
  }

  /** A requirement without document links may be removed; otherwise mark it NOT_APPLICABLE. */
  async delete(action: ActionContext, tenderId: string, requirementId: string, version: number): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await this.loadForChange(tx, action, organizationId, tenderId);
      this.assertManager(tender);
      const current = await tx.tenderRequirement.findFirst({
        where: { organizationId, tenderId, id: requirementId },
        select: { title: true, version: true, _count: { select: { links: true } } },
      });
      if (current === null) throw new NotFoundError('Requirement');
      if (current.version !== version) throw new VersionConflictError('Requirement');
      if (current._count.links > 0) {
        throw new ConflictError('The requirement has document history; mark it not applicable instead.');
      }
      const result = await tx.tenderRequirement.deleteMany({
        where: { organizationId, tenderId, id: requirementId, version },
      });
      if (result.count === 0) throw new VersionConflictError('Requirement');
      await recomputeTenderReadiness(tx, organizationId, tenderId);
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.requirement_removed', action.principal.memberId, {
        requirementId,
        title: current.title,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.requirement_deleted',
        entityType: 'tender_requirement',
        entityId: requirementId,
        actor: userActor(action),
        metadata: { tenderId },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
  }

  async changeStatus(
    action: ActionContext,
    tenderId: string,
    requirementId: string,
    input: RequirementStatusRequest,
  ): Promise<TenderRequirementView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await this.loadForChange(tx, action, organizationId, tenderId);
      const current = await tx.tenderRequirement.findFirst({
        where: { organizationId, tenderId, id: requirementId },
        select: { status: true, title: true, ownerMemberId: true, reviewerMemberId: true, mandatory: true },
      });
      const me = action.principal.memberId;
      if (current === null || !this.mayRead(tender, current, me)) throw new NotFoundError('Requirement');
      const actors = this.actorsOf(tender, current, me);
      if (actors.size === 0) throw new ForbiddenError();
      if (!requirementTransitionAllowed(current.status, input.status, actors)) {
        throw new InvalidTransitionError(`The requirement cannot move from ${current.status} to ${input.status}.`);
      }
      if (input.status === 'CHANGES_REQUIRED' && input.note === undefined) {
        throw new InvalidInputError('note', 'Explain the changes required.');
      }
      const now = this.clock();
      const decided = input.status === 'APPROVED' || input.status === 'CHANGES_REQUIRED';
      const data: Prisma.TenderRequirementUncheckedUpdateManyInput = {
        status: input.status,
        version: { increment: 1 },
        ...(decided ? { reviewedByMemberId: me, reviewedAt: now } : {}),
      };
      const result = await tx.tenderRequirement.updateMany({
        where: { organizationId, tenderId, id: requirementId, status: current.status, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Requirement');
      await recomputeTenderReadiness(tx, organizationId, tenderId);
      await appendTenderEvent(
        tx,
        organizationId,
        tenderId,
        input.status === 'APPROVED' ? 'tender.requirement_approved' : 'tender.requirement_status_changed',
        me,
        {
          requirementId,
          title: current.title,
          from: current.status,
          to: input.status,
          ...(input.note === undefined ? {} : { note: input.note }),
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'tender.requirement_status_changed',
        entityType: 'tender_requirement',
        entityId: requirementId,
        actor: userActor(action),
        metadata: { tenderId, from: current.status, to: input.status },
        context: action.request,
      });
      const key = tenderKey(tender.row.year, tender.row.number);
      const recipient =
        input.status === 'READY_FOR_REVIEW'
          ? current.reviewerMemberId
          : input.status === 'CHANGES_REQUIRED'
            ? current.ownerMemberId
            : null;
      if (recipient !== null) {
        const type =
          input.status === 'READY_FOR_REVIEW'
            ? 'TENDER_REQUIREMENT_REVIEW_REQUESTED'
            : 'TENDER_REQUIREMENT_CHANGES_REQUIRED';
        await notifyMembers(
          tx,
          organizationId,
          [recipient],
          {
            type,
            severity: input.status === 'CHANGES_REQUIRED' ? 'WARNING' : 'INFO',
            entityType: 'tender',
            entityId: tenderId,
            params: { tenderKey: key, tenderTitle: tender.row.title, requirementTitle: current.title },
            dedupeKey: `${type}:${requirementId}:${String(input.version + 1)}`,
          },
          async (principal) => (await loadTenderForAccess(tx, principal, organizationId, tenderId)) !== null,
          me,
        );
      }
      await announceCommercialChange(tx, organizationId, 'tender', tenderId);
    });
    return this.get(action, tenderId, requirementId);
  }

  async addLink(
    action: ActionContext,
    tenderId: string,
    requirementId: string,
    input: CreateRequirementLinkRequest,
  ): Promise<TenderRequirementView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await this.loadForChange(tx, action, organizationId, tenderId);
      const current = await tx.tenderRequirement.findFirst({
        where: { organizationId, tenderId, id: requirementId },
        select: { title: true, ownerMemberId: true, reviewerMemberId: true, status: true },
      });
      const me = action.principal.memberId;
      if (current === null || !this.mayRead(tender, current, me)) throw new NotFoundError('Requirement');
      const actors = this.actorsOf(tender, current, me);
      if (!actors.has('OWNER') && !actors.has('MANAGER')) throw new ForbiddenError();
      if (current.status === 'APPROVED' && !actors.has('MANAGER')) {
        throw new InvalidTransitionError('An approved requirement is changed by a requirement manager.');
      }
      if (input.corporateDocumentVersionId !== undefined) {
        const version = await tx.corporateDocumentVersion.findFirst({
          where: { organizationId, id: input.corporateDocumentVersionId },
          select: { document: { select: corporateAccessSelect } },
        });
        if (
          version === null ||
          !canViewCorporate(
            action.principal,
            corporateFacts(organizationId, version.document),
            version.document.classification,
          )
        ) {
          throw new InvalidInputError('corporateDocumentVersionId', 'Unknown document version.');
        }
        if (version.document.status !== 'ACTIVE') {
          throw new InvalidInputError('corporateDocumentVersionId', 'The document is archived.');
        }
      }
      if (input.commercialDocumentVersionId !== undefined) {
        const version = await tx.commercialDocumentVersion.findFirst({
          where: { organizationId, id: input.commercialDocumentVersionId, document: { tenderId } },
          select: { document: { select: { classification: true } } },
        });
        if (
          version === null ||
          !canViewCommercialDocument(tender, 'tender.financial.view', version.document.classification)
        ) {
          throw new InvalidInputError('commercialDocumentVersionId', 'Unknown document version of this tender.');
        }
      }
      const duplicate = await tx.tenderRequirementLink.findFirst({
        where: {
          organizationId,
          requirementId,
          removedAt: null,
          corporateDocumentVersionId: input.corporateDocumentVersionId ?? null,
          commercialDocumentVersionId: input.commercialDocumentVersionId ?? null,
        },
        select: { id: true },
      });
      if (duplicate !== null) return;
      const link = await tx.tenderRequirementLink.create({
        data: {
          organizationId,
          requirementId,
          corporateDocumentVersionId: input.corporateDocumentVersionId ?? null,
          commercialDocumentVersionId: input.commercialDocumentVersionId ?? null,
          note: input.note ?? null,
          createdByMemberId: me,
        },
        select: { id: true },
      });
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.requirement_document_linked', me, {
        requirementId,
        title: current.title,
        linkId: link.id,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.requirement_document_linked',
        entityType: 'tender_requirement',
        entityId: requirementId,
        actor: userActor(action),
        metadata: {
          tenderId,
          linkId: link.id,
          kind: input.corporateDocumentVersionId === undefined ? 'COMMERCIAL' : 'CORPORATE',
        },
        context: action.request,
      });
    });
    return this.get(action, tenderId, requirementId);
  }

  async removeLink(
    action: ActionContext,
    tenderId: string,
    requirementId: string,
    linkId: string,
  ): Promise<TenderRequirementView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const tender = await this.loadForChange(tx, action, organizationId, tenderId);
      const current = await tx.tenderRequirement.findFirst({
        where: { organizationId, tenderId, id: requirementId },
        select: { title: true, ownerMemberId: true, reviewerMemberId: true, status: true },
      });
      const me = action.principal.memberId;
      if (current === null || !this.mayRead(tender, current, me)) throw new NotFoundError('Requirement');
      const actors = this.actorsOf(tender, current, me);
      if (!actors.has('OWNER') && !actors.has('MANAGER')) throw new ForbiddenError();
      if (current.status === 'APPROVED' && !actors.has('MANAGER')) {
        throw new InvalidTransitionError('An approved requirement is changed by a requirement manager.');
      }
      const link = await tx.tenderRequirementLink.findFirst({
        where: { organizationId, requirementId, id: linkId, removedAt: null },
        select: linkAccessSelect,
      });
      if (link === null || !linkVisible(link, tender, action.principal, organizationId)) {
        throw new NotFoundError('Link');
      }
      const result = await tx.tenderRequirementLink.updateMany({
        where: { organizationId, requirementId, id: linkId, removedAt: null },
        data: { removedAt: this.clock(), removedByMemberId: me },
      });
      if (result.count === 0) throw new NotFoundError('Link');
      await appendTenderEvent(tx, organizationId, tenderId, 'tender.requirement_document_unlinked', me, {
        requirementId,
        title: current.title,
        linkId,
      });
      await recordAudit(tx, organizationId, {
        action: 'tender.requirement_document_unlinked',
        entityType: 'tender_requirement',
        entityId: requirementId,
        actor: userActor(action),
        metadata: { tenderId, linkId },
        context: action.request,
      });
    });
    return this.get(action, tenderId, requirementId);
  }

  /**
   * "My tender work" (owner and reviewer of requirements in tenders being prepared) and the manager
   * queues (unassigned, overdue, blocked, readiness-critical) over tenders whose requirements the
   * caller manages. Bounded; `truncated` tells the client more exist.
   */
  async work(action: ActionContext, query: TenderWorkQuery): Promise<TenderWorkView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const now = this.clock();
    const { today } = await organizationToday(this.db, organizationId, now);
    const me = action.principal.memberId;
    const view = query.view ?? 'mine';
    const editable: Prisma.TenderWhereInput = {
      status: { in: ['DRAFT', 'NEW', 'UNDER_REVIEW', 'BID_DECISION_PENDING', 'PREPARING'] },
    };
    const where: Prisma.TenderRequirementWhereInput = { organizationId };
    if (view === 'mine') {
      Object.assign(where, {
        tender: editable,
        OR: [
          { ownerMemberId: me, ...OPEN_REQUIREMENT },
          { reviewerMemberId: me, status: 'READY_FOR_REVIEW' },
        ],
      } satisfies Prisma.TenderRequirementWhereInput);
    } else {
      const visible = fullTenderWhere(action.principal);
      const managed = fullTenderWhere(action.principal, 'tender.manage_requirements');
      if (visible === null || managed === null)
        return { today, items: [], reviews: await this.myReviews(organizationId, me), truncated: false };
      const todayDate = new Date(`${today}T00:00:00.000Z`);
      const filter: Prisma.TenderRequirementWhereInput =
        view === 'unassigned'
          ? { ownerMemberId: null, ...OPEN_REQUIREMENT }
          : view === 'overdue'
            ? { dueDate: { lt: todayDate }, ...OPEN_REQUIREMENT }
            : view === 'blocked'
              ? { status: 'BLOCKED' }
              : {
                  mandatory: true,
                  ...OPEN_REQUIREMENT,
                  OR: [
                    { priority: 'CRITICAL' },
                    { tender: { submissionDeadlineAt: { lte: new Date(now.getTime() + 7 * DAY_MS) } } },
                  ],
                };
      Object.assign(where, {
        tender: { AND: [editable, visible, managed] },
        AND: [filter],
      } satisfies Prisma.TenderRequirementWhereInput);
    }
    const rows = await this.db.tenderRequirement.findMany({
      where,
      orderBy: [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      take: WORK_LIMIT + 1,
      select: {
        id: true,
        title: true,
        category: true,
        status: true,
        mandatory: true,
        dueDate: true,
        priority: true,
        ownerMemberId: true,
        reviewerMemberId: true,
        owner: { select: memberRefSelect },
        reviewer: { select: memberRefSelect },
        tender: { select: { ...tenderRefSelect, submissionDeadlineAt: true } },
      },
    });
    const truncated = rows.length > WORK_LIMIT;
    const items = rows.slice(0, WORK_LIMIT).map((row) => {
      const dueDate = dateOnly(row.dueDate);
      const overdue = isRequirementOverdue({ status: row.status, dueDate }, today);
      let bucket: WorkBucket;
      if (
        view === 'mine' &&
        row.reviewerMemberId === me &&
        row.status === 'READY_FOR_REVIEW' &&
        row.ownerMemberId !== me
      ) {
        bucket = 'REVIEW';
      } else if (row.status === 'BLOCKED') bucket = 'BLOCKED';
      else if (overdue) bucket = 'OVERDUE';
      else if (dueDate === today) bucket = 'DUE_TODAY';
      else if (row.ownerMemberId === null) bucket = 'UNASSIGNED';
      else if (dueDate === null) bucket = 'NO_DUE_DATE';
      else bucket = 'UPCOMING';
      return {
        requirement: {
          id: row.id,
          title: row.title,
          category: row.category,
          status: row.status,
          mandatory: row.mandatory,
          dueDate,
          overdue,
          priority: row.priority,
          owner: personOrNull(row.owner),
          reviewer: personOrNull(row.reviewer),
        },
        tender: {
          id: row.tender.id,
          key: tenderKey(row.tender.year, row.tender.number),
          title: row.tender.title,
          status: row.tender.status,
          submissionDeadlineAt: isoOrNull(row.tender.submissionDeadlineAt),
        },
        bucket,
      };
    });
    return { today, items, reviews: await this.myReviews(organizationId, me), truncated };
  }

  /**
   * Direct evidence files of a requirement (attachment owner TENDER_REQUIREMENT). Readable by whoever
   * reads the requirement; evidence of COMMERCIAL/FINANCIAL requirements may carry pricing, so FULL
   * readers other than its owner and reviewer also need `commercial_document.view`. Owners and
   * managers upload while the requirement is open and requirements are editable; evidence of an
   * approved requirement is kept (only managers delete, before approval).
   */
  async attachmentAccess(action: ActionContext, requirementId: string): Promise<OwnerAccess> {
    const none: OwnerAccess = { canView: false, canUpload: false, canDelete: false };
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.tenderRequirement.findFirst({
      where: { organizationId, id: requirementId },
      select: { tenderId: true, category: true, status: true, ownerMemberId: true, reviewerMemberId: true },
    });
    if (row === null) return none;
    const tender = await loadTenderForAccess(this.db, action.principal, organizationId, row.tenderId);
    const me = action.principal.memberId;
    if (tender === null || !this.mayRead(tender, row, me)) return none;
    const assigned = row.ownerMemberId === me || row.reviewerMemberId === me;
    const sensitive = row.category === 'COMMERCIAL' || row.category === 'FINANCIAL';
    if (sensitive && !assigned && !tender.can('commercial_document.view')) return none;
    const actors = this.actorsOf(tender, row, me);
    const open =
      requirementsEditable(tender.row.status) && row.status !== 'APPROVED' && row.status !== 'NOT_APPLICABLE';
    return {
      canView: true,
      canUpload: open && (actors.has('MANAGER') || actors.has('OWNER')),
      canDelete: open && actors.has('MANAGER'),
    };
  }

  // ---- internals ----

  private async myReviews(organizationId: string, memberId: string): Promise<TenderWorkView['reviews']> {
    const reviews = await this.db.tenderReview.findMany({
      where: { organizationId, reviewerMemberId: memberId, status: 'PENDING', gate: { status: 'OPEN' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
      select: {
        id: true,
        createdAt: true,
        gate: { select: { gate: true, openedAt: true } },
        tender: { select: tenderRefSelect },
      },
    });
    return reviews.map((review) => ({
      reviewId: review.id,
      gate: review.gate.gate,
      tender: toTenderRef(review.tender),
      requestedAt: iso(review.gate.openedAt ?? review.createdAt),
    }));
  }

  /** Loads the tender for a requirement change and takes its aggregate lock (counters stay consistent). */
  private async loadForChange(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    tenderId: string,
  ): Promise<LoadedTender> {
    const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
    await lockCommercialAggregate(tx, organizationId, 'tender', tenderId);
    if (!requirementsEditable(tender.row.status)) {
      throw new InvalidTransitionError(`Requirements cannot change while the tender is ${tender.row.status}.`);
    }
    return tender;
  }

  private assertManager(tender: LoadedTender): void {
    if (tender.level !== 'FULL' || !tender.can('tender.manage_requirements')) throw new ForbiddenError();
  }

  /** FULL readers see every requirement; INVOLVED members only the ones they own or review. */
  private mayRead(
    tender: LoadedTender,
    row: { ownerMemberId: string | null; reviewerMemberId: string | null },
    me: string,
  ): boolean {
    return tender.level === 'FULL' || row.ownerMemberId === me || row.reviewerMemberId === me;
  }

  private actorsOf(
    tender: LoadedTender,
    row: { ownerMemberId: string | null; reviewerMemberId: string | null },
    me: string,
  ): Set<RequirementActor> {
    const actors = new Set<RequirementActor>();
    if (tender.level === 'FULL' && tender.can('tender.manage_requirements')) actors.add('MANAGER');
    if (row.ownerMemberId === me) actors.add('OWNER');
    if (row.reviewerMemberId === me) actors.add('REVIEWER');
    return actors;
  }

  private async viewContext(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    tender: LoadedTender,
  ): Promise<{
    today: string;
    deadlineDate: string | null;
    me: string;
    editable: boolean;
    organizationId: string;
    action: ActionContext;
  }> {
    const { today } = await organizationToday(db, organizationId, this.clock());
    const zone = await db.tender.findFirstOrThrow({
      where: { organizationId, id: tender.row.id },
      select: { submissionDeadlineTimeZone: true },
    });
    const deadline = tender.row.submissionDeadlineAt;
    const deadlineDate =
      deadline === null || zone.submissionDeadlineTimeZone === null
        ? null
        : localToday(deadline, zone.submissionDeadlineTimeZone);
    return {
      today,
      deadlineDate,
      me: action.principal.memberId,
      editable: requirementsEditable(tender.row.status),
      organizationId,
      action,
    };
  }

  private toView(
    row: RequirementRow,
    tender: LoadedTender,
    context: {
      today: string;
      deadlineDate: string | null;
      me: string;
      editable: boolean;
      organizationId: string;
      action: ActionContext;
    },
  ): TenderRequirementView {
    const dueDate = dateOnly(row.dueDate);
    const actors = this.actorsOf(tender, row, context.me);
    const working = actors.has('OWNER') || actors.has('MANAGER');
    return {
      id: row.id,
      tenderId: row.tenderId,
      category: row.category,
      title: row.title,
      description: row.description,
      referenceSection: row.referenceSection,
      owner: personOrNull(row.owner),
      reviewer: personOrNull(row.reviewer),
      dueDate,
      priority: row.priority,
      mandatory: row.mandatory,
      status: row.status,
      overdue: isRequirementOverdue({ status: row.status, dueDate }, context.today),
      notes: row.notes,
      reviewedBy: personOrNull(row.reviewedBy),
      reviewedAt: isoOrNull(row.reviewedAt),
      links: row.links.flatMap((link) => {
        const view = this.toLinkView(link, tender, context);
        return view === null ? [] : [view];
      }),
      version: row.version,
      access: {
        canEdit: context.editable && actors.has('MANAGER'),
        canWork: context.editable && working && (row.status !== 'APPROVED' || actors.has('MANAGER')),
        canReview:
          context.editable && row.status === 'READY_FOR_REVIEW' && (actors.has('REVIEWER') || actors.has('MANAGER')),
        canLink: context.editable && working && (row.status !== 'APPROVED' || actors.has('MANAGER')),
      },
    };
  }

  /** Null for a link to a document hidden from the caller: the link itself (note, author) is not shown either. */
  private toLinkView(
    link: RequirementRow['links'][number],
    tender: LoadedTender,
    context: { deadlineDate: string | null; organizationId: string; action: ActionContext },
  ): RequirementLinkView | null {
    if (!linkVisible(link, tender, context.action.principal, context.organizationId)) return null;
    const base = {
      id: link.id,
      note: link.note,
      createdAt: iso(link.createdAt),
      createdBy: personOrNull(link.createdBy),
    };
    const corporate = link.corporateDocumentVersion;
    if (corporate !== null) {
      const expiryDate = dateOnly(corporate.expiryDate);
      return {
        ...base,
        kind: 'CORPORATE',
        document: {
          documentId: corporate.document.id,
          versionId: corporate.id,
          title: corporate.document.title,
          type: corporate.document.documentType,
          versionNumber: corporate.versionNumber,
          attachmentId: corporate.attachmentId,
          expiryDate,
          validOnDeadline: validOn({ validFrom: dateOnly(corporate.validFrom), expiryDate }, context.deadlineDate),
          isCurrentVersion: corporate.versionNumber === corporate.document.currentVersion,
        },
      };
    }
    const commercial = link.commercialDocumentVersion;
    if (commercial === null) return null;
    return {
      ...base,
      kind: 'COMMERCIAL',
      document: {
        documentId: commercial.document.id,
        versionId: commercial.id,
        title: commercial.document.title,
        type: commercial.document.category,
        versionNumber: commercial.versionNumber,
        attachmentId: commercial.attachmentId,
        expiryDate: null,
        validOnDeadline: null,
        isCurrentVersion: commercial.versionNumber === commercial.document.currentVersion,
      },
    };
  }

  private async notifyAssigned(
    tx: TenantDb,
    organizationId: string,
    tender: LoadedTender,
    requirementId: string,
    title: string,
    ownerMemberId: string,
    actorMemberId: string,
  ): Promise<void> {
    await notifyMembers(
      tx,
      organizationId,
      [ownerMemberId],
      {
        type: 'TENDER_REQUIREMENT_ASSIGNED',
        severity: 'INFO',
        entityType: 'tender',
        entityId: tender.row.id,
        params: {
          tenderKey: tenderKey(tender.row.year, tender.row.number),
          tenderTitle: tender.row.title,
          requirementTitle: title,
        },
        dedupeKey: `TENDER_REQUIREMENT_ASSIGNED:${requirementId}:${ownerMemberId}`,
      },
      // The new owner becomes INVOLVED through the assignment written in this transaction.
      async (principal) => (await loadTenderForAccess(tx, principal, organizationId, tender.row.id)) !== null,
      actorMemberId,
    );
  }
}

function toDate(value: string | null | undefined): Date | null {
  return value == null ? null : new Date(`${value}T00:00:00.000Z`);
}

const linkAccessSelect = {
  corporateDocumentVersion: { select: { document: { select: corporateAccessSelect } } },
  commercialDocumentVersion: { select: { document: { select: { classification: true } } } },
} satisfies Prisma.TenderRequirementLinkSelect;

/** Whether the caller may see the document a requirement link points to. */
function linkVisible(
  link: Prisma.TenderRequirementLinkGetPayload<{ select: typeof linkAccessSelect }>,
  tender: LoadedTender,
  principal: Principal,
  organizationId: string,
): boolean {
  const corporate = link.corporateDocumentVersion;
  if (corporate !== null) {
    return canViewCorporate(
      principal,
      corporateFacts(organizationId, corporate.document),
      corporate.document.classification,
    );
  }
  const commercial = link.commercialDocumentVersion;
  return (
    commercial !== null &&
    canViewCommercialDocument(tender, 'tender.financial.view', commercial.document.classification)
  );
}

/**
 * Rewrites the tender's stored readiness counters from its requirements. Called inside the
 * transaction of every requirement change, after `lockCommercialAggregate`. The tender's version is
 * not bumped (counters are derived data, not an edit of the tender).
 */
export async function recomputeTenderReadiness(tx: TenantDb, organizationId: string, tenderId: string): Promise<void> {
  const rows = await tx.tenderRequirement.findMany({
    where: { organizationId, tenderId },
    select: { status: true, mandatory: true, ownerMemberId: true, dueDate: true },
  });
  const counters = readinessCounters(rows.map((row) => ({ ...row, dueDate: dateOnly(row.dueDate) })));
  await tx.tender.updateMany({ where: { organizationId, id: tenderId }, data: counters });
}
