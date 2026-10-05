import type { AttachmentOwnerType, MilestoneStatus, ObligationStatus, Prisma } from '@company-ops/db';
import type {
  CreateMilestoneRequest,
  CreateObligationRequest,
  MilestoneStatusRequest,
  OccurrenceListQuery,
  OccurrenceStatusRequest,
  UpdateMilestoneRequest,
  UpdateObligationRequest,
} from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockCommercialAggregate } from '../../platform/db/sql/locks.js';
import {
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
import { canAccessResource } from '../authorization/policy.js';
import { loadProjectForAccess } from '../projects/project-access.js';
import {
  assertCan,
  loadContractForAccess,
  loadVisibleContract,
  versionClassificationSelect,
  visibleDocumentWhere,
  visibleVersionId,
} from './commercial-access.js';
import type { LoadedContract } from './commercial-access.js';
import {
  announceCommercialChange,
  appendContractEvent,
  assertActiveMembers,
  dateOnly,
  dateOnlyStrict,
  isoOrNull,
  memberRefSelect,
  notifyMembers,
  organizationToday,
  personOrNull,
} from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { refreshContract } from './contract-refresh.js';
import { contractKey } from './engine/contract-state.js';
import { extendObligation } from './obligation-generation.js';

export type OccurrenceStatusView = ObligationStatus | 'OVERDUE';
export type MilestoneStatusView = MilestoneStatus | 'OVERDUE';

export interface OccurrenceView {
  readonly id: string;
  readonly obligationId: string;
  readonly contractId: string;
  readonly title: string;
  readonly category: OccurrenceRow['obligation']['category'];
  readonly criticality: OccurrenceRow['obligation']['criticality'];
  readonly evidenceRequired: boolean;
  readonly dueDate: string;
  readonly status: OccurrenceStatusView;
  readonly owner: PersonRef | null;
  readonly completedAt: string | null;
  readonly completedBy: PersonRef | null;
  readonly completionNote: string | null;
  readonly evidenceVersionId: string | null;
  readonly evidenceAttachments: number;
  readonly waivedReason: string | null;
  readonly version: number;
  readonly canWork: boolean;
}

export interface ObligationView {
  readonly id: string;
  readonly contractId: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: OccurrenceRow['obligation']['category'];
  readonly owner: PersonRef | null;
  readonly reviewer: PersonRef | null;
  readonly priority: ObligationRow['priority'];
  readonly criticality: ObligationRow['criticality'];
  readonly evidenceRequired: boolean;
  readonly recurrence: ObligationRow['recurrence'];
  readonly dueDate: string;
  readonly recurrenceUntil: string | null;
  readonly generatedThrough: string | null;
  readonly notes: string | null;
  readonly cancelledAt: string | null;
  readonly occurrences: OccurrenceView[];
  readonly version: number;
}

export interface MilestoneView {
  readonly id: string;
  readonly contractId: string;
  readonly project: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly title: string;
  readonly description: string | null;
  readonly owner: PersonRef | null;
  readonly dueDate: string;
  readonly status: MilestoneStatusView;
  readonly approvalRequired: boolean;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: PersonRef | null;
  readonly completedAt: string | null;
  readonly completedBy: PersonRef | null;
  readonly evidenceAttachments: number;
  readonly version: number;
  readonly canWork: boolean;
}

const occurrenceSelect = {
  id: true,
  obligationId: true,
  contractId: true,
  dueDate: true,
  status: true,
  ownerMemberId: true,
  completedAt: true,
  completionNote: true,
  evidenceVersionId: true,
  evidenceVersion: versionClassificationSelect,
  waivedReason: true,
  version: true,
  owner: { select: memberRefSelect },
  completedBy: { select: memberRefSelect },
  obligation: {
    select: {
      title: true,
      category: true,
      criticality: true,
      evidenceRequired: true,
      ownerMemberId: true,
      reviewerMemberId: true,
    },
  },
} satisfies Prisma.ContractObligationOccurrenceSelect;
type OccurrenceRow = Prisma.ContractObligationOccurrenceGetPayload<{ select: typeof occurrenceSelect }>;

const obligationSelect = {
  id: true,
  contractId: true,
  title: true,
  description: true,
  category: true,
  ownerMemberId: true,
  reviewerMemberId: true,
  priority: true,
  criticality: true,
  evidenceRequired: true,
  recurrence: true,
  dueDate: true,
  recurrenceUntil: true,
  generatedThrough: true,
  notes: true,
  cancelledAt: true,
  version: true,
  owner: { select: memberRefSelect },
  reviewer: { select: memberRefSelect },
} satisfies Prisma.ContractObligationSelect;
type ObligationRow = Prisma.ContractObligationGetPayload<{ select: typeof obligationSelect }>;

const milestoneSelect = {
  id: true,
  contractId: true,
  title: true,
  description: true,
  ownerMemberId: true,
  dueDate: true,
  status: true,
  approvalRequired: true,
  submittedAt: true,
  approvedAt: true,
  completedAt: true,
  version: true,
  project: { select: { id: true, code: true, name: true } },
  owner: { select: memberRefSelect },
  approvedBy: { select: memberRefSelect },
  completedBy: { select: memberRefSelect },
} satisfies Prisma.ContractMilestoneSelect;
type MilestoneRow = Prisma.ContractMilestoneGetPayload<{ select: typeof milestoneSelect }>;

const OPEN_OCCURRENCE_STATUSES: readonly ObligationStatus[] = ['UPCOMING', 'IN_PROGRESS'];
const OPEN_MILESTONE_STATUSES: readonly MilestoneStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED'];
const OCCURRENCES_PER_OBLIGATION = 24;

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const toDay = (value: string | null | undefined): Date | null => (value == null ? null : day(value));

/**
 * Contract obligations with bounded recurring occurrences (spec §38-§40) and milestones (spec §41).
 * Occurrences are the work items: owners progress and complete them, completion of an
 * evidence-required obligation needs a document version or an attachment first, waivers are a
 * manager decision with a reason, and nothing is ever completed automatically. Every change refreshes
 * the contract's stored health in the same transaction.
 */
export class ContractWorkService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---- Obligations ----

  async listObligations(action: ActionContext, contractId: string): Promise<ObligationView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    const me = action.principal.memberId;
    const where: Prisma.ContractObligationWhereInput =
      contract.level === 'FULL'
        ? { organizationId, contractId }
        : {
            organizationId,
            contractId,
            OR: [{ ownerMemberId: me }, { reviewerMemberId: me }, { occurrences: { some: { ownerMemberId: me } } }],
          };
    const rows = await this.db.contractObligation.findMany({
      where,
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 200,
      select: obligationSelect,
    });
    return this.obligationViews(organizationId, contract, rows, me);
  }

  async createObligation(
    action: ActionContext,
    contractId: string,
    input: CreateObligationRequest,
  ): Promise<ObligationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const contract = await this.loadManaged(tx, action, organizationId, contractId, 'contract.manage_obligations');
      await assertActiveMembers(tx, organizationId, [
        ['ownerMemberId', input.ownerMemberId],
        ['reviewerMemberId', input.reviewerMemberId],
      ]);
      const recurrence = input.recurrence ?? 'NONE';
      if (recurrence === 'NONE' && input.recurrenceUntil != null) {
        throw new InvalidInputError('recurrenceUntil', 'A one-time obligation has no recurrence end.');
      }
      const created = await tx.contractObligation.create({
        data: {
          organizationId,
          contractId,
          title: input.title,
          description: input.description ?? null,
          category: input.category,
          ownerMemberId: input.ownerMemberId ?? null,
          reviewerMemberId: input.reviewerMemberId ?? null,
          priority: input.priority ?? 'MEDIUM',
          criticality: input.criticality ?? 'STANDARD',
          evidenceRequired: input.evidenceRequired ?? false,
          recurrence,
          dueDate: day(input.dueDate),
          recurrenceUntil: toDay(input.recurrenceUntil),
          notes: input.notes ?? null,
          createdByMemberId: action.principal.memberId,
        },
        select: {
          id: true,
          contractId: true,
          recurrence: true,
          dueDate: true,
          recurrenceUntil: true,
          generatedThrough: true,
          ownerMemberId: true,
          cancelledAt: true,
        },
      });
      const { today } = await organizationToday(tx, organizationId, this.clock());
      await extendObligation(tx, organizationId, created, today);
      await refreshContract(tx, organizationId, contractId, today);
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        'contract.obligation_created',
        action.principal.memberId,
        {
          obligationId: created.id,
          title: input.title,
          recurrence,
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.obligation_created',
        entityType: 'contract_obligation',
        entityId: created.id,
        actor: userActor(action),
        metadata: { contractId, recurrence, evidenceRequired: input.evidenceRequired ?? false },
        context: action.request,
      });
      if (input.ownerMemberId != null) {
        await this.notifyWork(
          tx,
          organizationId,
          contract,
          [input.ownerMemberId],
          'CONTRACT_OBLIGATION_ASSIGNED',
          created.id,
          input.title,
          action.principal.memberId,
        );
      }
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
      return created.id;
    });
    return this.getObligation(action, contractId, id);
  }

  async updateObligation(
    action: ActionContext,
    contractId: string,
    obligationId: string,
    input: UpdateObligationRequest,
  ): Promise<ObligationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await this.loadManaged(tx, action, organizationId, contractId, 'contract.manage_obligations');
      const current = await tx.contractObligation.findFirst({
        where: { organizationId, contractId, id: obligationId },
        select: { title: true, ownerMemberId: true, cancelledAt: true },
      });
      if (current === null) throw new NotFoundError('Obligation');
      if (current.cancelledAt !== null) throw new InvalidTransitionError('The obligation is cancelled.');
      await assertActiveMembers(tx, organizationId, [
        ['ownerMemberId', input.ownerMemberId],
        ['reviewerMemberId', input.reviewerMemberId],
      ]);
      const data: Prisma.ContractObligationUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.category !== undefined) data.category = input.category;
      if (input.ownerMemberId !== undefined) data.ownerMemberId = input.ownerMemberId;
      if (input.reviewerMemberId !== undefined) data.reviewerMemberId = input.reviewerMemberId;
      if (input.priority !== undefined) data.priority = input.priority;
      if (input.criticality !== undefined) data.criticality = input.criticality;
      if (input.evidenceRequired !== undefined) data.evidenceRequired = input.evidenceRequired;
      if (input.notes !== undefined) data.notes = input.notes;
      const result = await tx.contractObligation.updateMany({
        where: { organizationId, contractId, id: obligationId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Obligation');
      const ownerChanged = input.ownerMemberId !== undefined && input.ownerMemberId !== current.ownerMemberId;
      if (ownerChanged) {
        // Open occurrences follow the obligation owner unless they were reassigned individually.
        await tx.contractObligationOccurrence.updateMany({
          where: {
            organizationId,
            obligationId,
            status: { in: [...OPEN_OCCURRENCE_STATUSES] },
            ownerMemberId: current.ownerMemberId,
          },
          data: { ownerMemberId: input.ownerMemberId ?? null, version: { increment: 1 } },
        });
      }
      const { today } = await organizationToday(tx, organizationId, this.clock());
      await refreshContract(tx, organizationId, contractId, today);
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        'contract.obligation_updated',
        action.principal.memberId,
        {
          obligationId,
          title: input.title ?? current.title,
          ownerChanged,
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.obligation_updated',
        entityType: 'contract_obligation',
        entityId: obligationId,
        actor: userActor(action),
        metadata: { contractId, fields: Object.keys(input).filter((key) => key !== 'version') },
        context: action.request,
      });
      if (ownerChanged && input.ownerMemberId != null) {
        await this.notifyWork(
          tx,
          organizationId,
          contract,
          [input.ownerMemberId],
          'CONTRACT_OBLIGATION_ASSIGNED',
          obligationId,
          input.title ?? current.title,
          action.principal.memberId,
        );
      }
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    return this.getObligation(action, contractId, obligationId);
  }

  /** Cancels the obligation and its open occurrences (completed history stays). */
  async cancelObligation(
    action: ActionContext,
    contractId: string,
    obligationId: string,
    version: number,
  ): Promise<ObligationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      await this.loadManaged(tx, action, organizationId, contractId, 'contract.manage_obligations');
      const now = this.clock();
      const result = await tx.contractObligation.updateMany({
        where: { organizationId, contractId, id: obligationId, version, cancelledAt: null },
        data: { cancelledAt: now, version: { increment: 1 } },
      });
      if (result.count === 0) {
        const exists = await tx.contractObligation.findFirst({
          where: { organizationId, contractId, id: obligationId },
          select: { cancelledAt: true },
        });
        if (exists === null) throw new NotFoundError('Obligation');
        if (exists.cancelledAt !== null) throw new InvalidTransitionError('The obligation is already cancelled.');
        throw new VersionConflictError('Obligation');
      }
      await tx.contractObligationOccurrence.updateMany({
        where: { organizationId, obligationId, status: { in: [...OPEN_OCCURRENCE_STATUSES] } },
        data: { status: 'CANCELLED', version: { increment: 1 } },
      });
      const { today } = await organizationToday(tx, organizationId, now);
      await refreshContract(tx, organizationId, contractId, today);
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        'contract.obligation_cancelled',
        action.principal.memberId,
        { obligationId },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.obligation_cancelled',
        entityType: 'contract_obligation',
        entityId: obligationId,
        actor: userActor(action),
        metadata: { contractId },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    return this.getObligation(action, contractId, obligationId);
  }

  async listOccurrences(
    action: ActionContext,
    contractId: string,
    query: OccurrenceListQuery,
  ): Promise<OccurrenceView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const me = action.principal.memberId;
    const and: Prisma.ContractObligationOccurrenceWhereInput[] = [];
    if (contract.level !== 'FULL') {
      and.push({
        OR: [{ ownerMemberId: me }, { obligation: { OR: [{ ownerMemberId: me }, { reviewerMemberId: me }] } }],
      });
    }
    if (query.status !== undefined) {
      const stored = query.status.filter((status): status is ObligationStatus => status !== 'OVERDUE');
      const or: Prisma.ContractObligationOccurrenceWhereInput[] = [];
      if (query.status.includes('OVERDUE')) {
        or.push({ status: { in: [...OPEN_OCCURRENCE_STATUSES] }, dueDate: { lt: day(today) } });
      }
      const openRequested = stored.filter((status) => OPEN_OCCURRENCE_STATUSES.includes(status));
      const closedRequested = stored.filter((status) => !OPEN_OCCURRENCE_STATUSES.includes(status));
      if (openRequested.length > 0) or.push({ status: { in: openRequested }, dueDate: { gte: day(today) } });
      if (closedRequested.length > 0) or.push({ status: { in: closedRequested } });
      and.push({ OR: or });
    }
    const rows = await this.db.contractObligationOccurrence.findMany({
      where: { organizationId, contractId, AND: and },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 300,
      select: occurrenceSelect,
    });
    return this.occurrenceViews(organizationId, contract, rows, today, me);
  }

  async changeOccurrenceStatus(
    action: ActionContext,
    contractId: string,
    occurrenceId: string,
    input: OccurrenceStatusRequest,
  ): Promise<OccurrenceView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await loadVisibleContract(tx, action, organizationId, contractId);
      await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
      const row = await tx.contractObligationOccurrence.findFirst({
        where: { organizationId, contractId, id: occurrenceId },
        select: occurrenceSelect,
      });
      const me = action.principal.memberId;
      if (row === null || !this.mayReadOccurrence(contract, row, me)) throw new NotFoundError('Occurrence');
      const manager = this.isManager(contract, 'contract.manage_obligations');
      const worker =
        manager ||
        row.ownerMemberId === me ||
        row.obligation.ownerMemberId === me ||
        row.obligation.reviewerMemberId === me;
      if (!worker) throw new ForbiddenError();
      if (contract.row.status === 'CLOSED') throw new InvalidTransitionError('The contract is closed.');
      if (!OPEN_OCCURRENCE_STATUSES.includes(row.status)) {
        throw new InvalidTransitionError(`A ${row.status} occurrence cannot change.`);
      }
      const now = this.clock();
      const data: Prisma.ContractObligationOccurrenceUncheckedUpdateManyInput = {
        status: input.status,
        version: { increment: 1 },
      };
      if (input.status === 'IN_PROGRESS') {
        if (row.status === 'IN_PROGRESS') throw new InvalidTransitionError('The occurrence is already in progress.');
      } else if (input.status === 'WAIVED') {
        if (!manager) throw new ForbiddenError('Waiving an obligation is a contract manager decision.');
        if (input.waivedReason === undefined) throw new InvalidInputError('waivedReason', 'A waiver needs its reason.');
        data.waivedReason = input.waivedReason;
      } else {
        if (input.evidenceVersionId != null) {
          const version = await tx.commercialDocumentVersion.findFirst({
            where: {
              organizationId,
              id: input.evidenceVersionId,
              document: { contractId, ...visibleDocumentWhere(contract, 'contract.financial.view') },
            },
            select: { id: true },
          });
          if (version === null)
            throw new InvalidInputError('evidenceVersionId', 'Unknown document version of this contract.');
          data.evidenceVersionId = input.evidenceVersionId;
        }
        if (row.obligation.evidenceRequired) {
          const hasVersion = (input.evidenceVersionId ?? row.evidenceVersionId) !== null;
          const attachments = hasVersion
            ? 0
            : await tx.attachment.count({
                where: {
                  organizationId,
                  ownerType: 'OBLIGATION_OCCURRENCE',
                  ownerId: occurrenceId,
                  status: 'AVAILABLE',
                },
              });
          if (!hasVersion && attachments === 0) {
            throw new InvalidInputError('evidenceVersionId', 'This obligation needs completion evidence first.');
          }
        }
        data.completedAt = now;
        data.completedByMemberId = me;
        data.completionNote = input.note ?? null;
      }
      const result = await tx.contractObligationOccurrence.updateMany({
        where: { organizationId, id: occurrenceId, status: row.status, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Occurrence');
      const { today } = await organizationToday(tx, organizationId, now);
      await refreshContract(tx, organizationId, contractId, today);
      if (input.status !== 'IN_PROGRESS') {
        await appendContractEvent(
          tx,
          organizationId,
          contractId,
          input.status === 'COMPLETED' ? 'contract.obligation_completed' : 'contract.obligation_waived',
          me,
          {
            obligationId: row.obligationId,
            occurrenceId,
            title: row.obligation.title,
            dueDate: dateOnlyStrict(row.dueDate),
          },
        );
      }
      await recordAudit(tx, organizationId, {
        action: 'contract.obligation_occurrence_status_changed',
        entityType: 'contract_obligation_occurrence',
        entityId: occurrenceId,
        actor: userActor(action),
        metadata: { contractId, from: row.status, to: input.status },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    const views = await this.listOccurrences(action, contractId, {});
    const view = views.find((occurrence) => occurrence.id === occurrenceId);
    if (view === undefined) throw new NotFoundError('Occurrence');
    return view;
  }

  // ---- Milestones ----

  async listMilestones(action: ActionContext, contractId: string): Promise<MilestoneView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    const me = action.principal.memberId;
    const rows = await this.db.contractMilestone.findMany({
      where: { organizationId, contractId, ...(contract.level === 'FULL' ? {} : { ownerMemberId: me }) },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
      take: 300,
      select: milestoneSelect,
    });
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    return this.milestoneViews(organizationId, contract, rows, today, me);
  }

  async createMilestone(
    action: ActionContext,
    contractId: string,
    input: CreateMilestoneRequest,
  ): Promise<MilestoneView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const contract = await this.loadManaged(tx, action, organizationId, contractId, 'contract.manage_milestones');
      await assertActiveMembers(tx, organizationId, [['ownerMemberId', input.ownerMemberId]]);
      if (input.projectId != null) await this.assertProject(tx, action, organizationId, input.projectId);
      const created = await tx.contractMilestone.create({
        data: {
          organizationId,
          contractId,
          projectId: input.projectId ?? null,
          title: input.title,
          description: input.description ?? null,
          ownerMemberId: input.ownerMemberId ?? null,
          dueDate: day(input.dueDate),
          approvalRequired: input.approvalRequired ?? false,
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true },
      });
      const { today } = await organizationToday(tx, organizationId, this.clock());
      await refreshContract(tx, organizationId, contractId, today);
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        'contract.milestone_created',
        action.principal.memberId,
        {
          milestoneId: created.id,
          title: input.title,
          dueDate: input.dueDate,
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.milestone_created',
        entityType: 'contract_milestone',
        entityId: created.id,
        actor: userActor(action),
        metadata: { contractId },
        context: action.request,
      });
      if (input.ownerMemberId != null) {
        await this.notifyWork(
          tx,
          organizationId,
          contract,
          [input.ownerMemberId],
          'CONTRACT_MILESTONE_ASSIGNED',
          created.id,
          input.title,
          action.principal.memberId,
        );
      }
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
      return created.id;
    });
    return this.getMilestone(action, contractId, id);
  }

  async updateMilestone(
    action: ActionContext,
    contractId: string,
    milestoneId: string,
    input: UpdateMilestoneRequest,
  ): Promise<MilestoneView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await this.loadManaged(tx, action, organizationId, contractId, 'contract.manage_milestones');
      const current = await tx.contractMilestone.findFirst({
        where: { organizationId, contractId, id: milestoneId },
        select: { title: true, status: true, ownerMemberId: true },
      });
      if (current === null) throw new NotFoundError('Milestone');
      if (!OPEN_MILESTONE_STATUSES.includes(current.status))
        throw new InvalidTransitionError(`A ${current.status} milestone cannot be edited.`);
      await assertActiveMembers(tx, organizationId, [['ownerMemberId', input.ownerMemberId]]);
      if (input.projectId != null) await this.assertProject(tx, action, organizationId, input.projectId);
      const data: Prisma.ContractMilestoneUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.projectId !== undefined) data.projectId = input.projectId;
      if (input.ownerMemberId !== undefined) data.ownerMemberId = input.ownerMemberId;
      if (input.dueDate !== undefined) data.dueDate = day(input.dueDate);
      if (input.approvalRequired !== undefined) data.approvalRequired = input.approvalRequired;
      const result = await tx.contractMilestone.updateMany({
        where: { organizationId, contractId, id: milestoneId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Milestone');
      const { today } = await organizationToday(tx, organizationId, this.clock());
      await refreshContract(tx, organizationId, contractId, today);
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        'contract.milestone_updated',
        action.principal.memberId,
        {
          milestoneId,
          title: input.title ?? current.title,
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.milestone_updated',
        entityType: 'contract_milestone',
        entityId: milestoneId,
        actor: userActor(action),
        metadata: { contractId, fields: Object.keys(input).filter((key) => key !== 'version') },
        context: action.request,
      });
      if (input.ownerMemberId != null && input.ownerMemberId !== current.ownerMemberId) {
        await this.notifyWork(
          tx,
          organizationId,
          contract,
          [input.ownerMemberId],
          'CONTRACT_MILESTONE_ASSIGNED',
          milestoneId,
          input.title ?? current.title,
          action.principal.memberId,
        );
      }
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    return this.getMilestone(action, contractId, milestoneId);
  }

  /**
   * Milestone flow: NOT_STARTED -> IN_PROGRESS -> (SUBMITTED -> APPROVED when approval is required)
   * -> COMPLETED. Owners and milestone managers work it; approval and returning a submission need
   * `contract.approve`; cancelling is a manager decision.
   */
  async changeMilestoneStatus(
    action: ActionContext,
    contractId: string,
    milestoneId: string,
    input: MilestoneStatusRequest,
  ): Promise<MilestoneView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await loadVisibleContract(tx, action, organizationId, contractId);
      await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
      const row = await tx.contractMilestone.findFirst({
        where: { organizationId, contractId, id: milestoneId },
        select: { status: true, ownerMemberId: true, approvalRequired: true, title: true },
      });
      const me = action.principal.memberId;
      if (row === null || (contract.level !== 'FULL' && row.ownerMemberId !== me)) throw new NotFoundError('Milestone');
      if (contract.row.status === 'CLOSED') throw new InvalidTransitionError('The contract is closed.');
      const manager = this.isManager(contract, 'contract.manage_milestones');
      const worker = manager || row.ownerMemberId === me;
      const approver = contract.level === 'FULL' && contract.can('contract.approve');
      const from = row.status;
      const to = input.status;
      let allowed: boolean;
      if (to === 'IN_PROGRESS') allowed = (from === 'NOT_STARTED' && worker) || (from === 'SUBMITTED' && approver);
      else if (to === 'SUBMITTED')
        allowed = row.approvalRequired && (from === 'IN_PROGRESS' || from === 'NOT_STARTED') && worker;
      else if (to === 'APPROVED') allowed = from === 'SUBMITTED' && approver;
      else if (to === 'COMPLETED') {
        allowed =
          worker && (row.approvalRequired ? from === 'APPROVED' : from === 'IN_PROGRESS' || from === 'NOT_STARTED');
      } else allowed = manager && OPEN_MILESTONE_STATUSES.includes(from);
      if (!allowed) {
        if (!worker && !approver) throw new ForbiddenError();
        throw new InvalidTransitionError(`The milestone cannot move from ${from} to ${to}.`);
      }
      const now = this.clock();
      const data: Prisma.ContractMilestoneUncheckedUpdateManyInput = { status: to, version: { increment: 1 } };
      if (to === 'SUBMITTED') data.submittedAt = now;
      if (to === 'APPROVED') {
        data.approvedAt = now;
        data.approvedByMemberId = me;
      }
      if (to === 'COMPLETED') {
        data.completedAt = now;
        data.completedByMemberId = me;
      }
      const result = await tx.contractMilestone.updateMany({
        where: { organizationId, id: milestoneId, status: from, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Milestone');
      const { today } = await organizationToday(tx, organizationId, now);
      await refreshContract(tx, organizationId, contractId, today);
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        to === 'COMPLETED'
          ? 'contract.milestone_completed'
          : to === 'APPROVED'
            ? 'contract.milestone_approved'
            : 'contract.milestone_status_changed',
        me,
        { milestoneId, title: row.title, from, to, ...(input.note === undefined ? {} : { note: input.note }) },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.milestone_status_changed',
        entityType: 'contract_milestone',
        entityId: milestoneId,
        actor: userActor(action),
        metadata: { contractId, from, to },
        context: action.request,
      });
      if (to === 'SUBMITTED') {
        await this.notifyWork(
          tx,
          organizationId,
          contract,
          [contract.row.ownerMemberId],
          'CONTRACT_MILESTONE_SUBMITTED',
          milestoneId,
          row.title,
          me,
        );
      }
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    return this.getMilestone(action, contractId, milestoneId);
  }

  // ---- Attachment owner policies ----

  async occurrenceAttachmentAccess(action: ActionContext, occurrenceId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const none = { canView: false, canUpload: false, canDelete: false };
    const row = await this.db.contractObligationOccurrence.findFirst({
      where: { organizationId, id: occurrenceId },
      select: occurrenceSelect,
    });
    if (row === null) return none;
    const contract = await loadContractForAccess(this.db, action.principal, organizationId, row.contractId);
    const me = action.principal.memberId;
    if (contract === null || !this.mayReadOccurrence(contract, row, me)) return none;
    const worker =
      this.isManager(contract, 'contract.manage_obligations') ||
      row.ownerMemberId === me ||
      row.obligation.ownerMemberId === me ||
      row.obligation.reviewerMemberId === me;
    const open = OPEN_OCCURRENCE_STATUSES.includes(row.status) && contract.row.status !== 'CLOSED';
    return { canView: true, canUpload: open && worker, canDelete: false };
  }

  async milestoneAttachmentAccess(action: ActionContext, milestoneId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const none = { canView: false, canUpload: false, canDelete: false };
    const row = await this.db.contractMilestone.findFirst({
      where: { organizationId, id: milestoneId },
      select: { contractId: true, ownerMemberId: true, status: true },
    });
    if (row === null) return none;
    const contract = await loadContractForAccess(this.db, action.principal, organizationId, row.contractId);
    const me = action.principal.memberId;
    if (contract === null || (contract.level !== 'FULL' && row.ownerMemberId !== me)) return none;
    const worker = this.isManager(contract, 'contract.manage_milestones') || row.ownerMemberId === me;
    const open = OPEN_MILESTONE_STATUSES.includes(row.status) && contract.row.status !== 'CLOSED';
    return { canView: true, canUpload: open && worker, canDelete: false };
  }

  // ---- internals ----

  private async getObligation(
    action: ActionContext,
    contractId: string,
    obligationId: string,
  ): Promise<ObligationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    const row = await this.db.contractObligation.findFirst({
      where: { organizationId, contractId, id: obligationId },
      select: obligationSelect,
    });
    if (row === null) throw new NotFoundError('Obligation');
    const [view] = await this.obligationViews(organizationId, contract, [row], action.principal.memberId);
    if (view === undefined) throw new NotFoundError('Obligation');
    return view;
  }

  private async getMilestone(action: ActionContext, contractId: string, milestoneId: string): Promise<MilestoneView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    const row = await this.db.contractMilestone.findFirst({
      where: { organizationId, contractId, id: milestoneId },
      select: milestoneSelect,
    });
    const me = action.principal.memberId;
    if (row === null || (contract.level !== 'FULL' && row.ownerMemberId !== me)) throw new NotFoundError('Milestone');
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const [view] = await this.milestoneViews(organizationId, contract, [row], today, me);
    if (view === undefined) throw new NotFoundError('Milestone');
    return view;
  }

  private async loadManaged(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    contractId: string,
    permission: 'contract.manage_obligations' | 'contract.manage_milestones',
  ): Promise<LoadedContract> {
    const contract = await loadVisibleContract(tx, action, organizationId, contractId);
    if (contract.level !== 'FULL') throw new ForbiddenError();
    assertCan(contract, permission);
    if (contract.row.status === 'CLOSED') throw new InvalidTransitionError('The contract is closed.');
    await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
    return contract;
  }

  private isManager(
    contract: LoadedContract,
    permission: 'contract.manage_obligations' | 'contract.manage_milestones',
  ): boolean {
    return contract.level === 'FULL' && contract.can(permission);
  }

  private mayReadOccurrence(contract: LoadedContract, row: OccurrenceRow, me: string): boolean {
    return (
      contract.level === 'FULL' ||
      row.ownerMemberId === me ||
      row.obligation.ownerMemberId === me ||
      row.obligation.reviewerMemberId === me
    );
  }

  private async assertProject(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    projectId: string,
  ): Promise<void> {
    const project = await loadProjectForAccess(tx, organizationId, projectId);
    if (project === null || !canAccessResource(action.principal, 'project.view', project.facts)) {
      throw new InvalidInputError('projectId', 'Unknown project.');
    }
  }

  private async attachmentCounts(
    organizationId: string,
    ownerType: AttachmentOwnerType,
    ownerIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (ownerIds.length === 0) return counts;
    const rows = await this.db.attachment.findMany({
      where: { organizationId, ownerType, ownerId: { in: [...ownerIds] }, status: 'AVAILABLE' },
      select: { ownerId: true },
      take: 5000,
    });
    for (const row of rows) counts.set(row.ownerId, (counts.get(row.ownerId) ?? 0) + 1);
    return counts;
  }

  private async obligationViews(
    organizationId: string,
    contract: LoadedContract,
    rows: readonly ObligationRow[],
    me: string,
  ): Promise<ObligationView[]> {
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const occurrences =
      rows.length === 0
        ? []
        : await this.db.contractObligationOccurrence.findMany({
            where: { organizationId, obligationId: { in: rows.map((row) => row.id) } },
            orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
            take: rows.length * OCCURRENCES_PER_OBLIGATION * 2,
            select: occurrenceSelect,
          });
    const views = await this.occurrenceViews(organizationId, contract, occurrences, today, me);
    const byObligation = new Map<string, OccurrenceView[]>();
    for (const view of views) {
      const list = byObligation.get(view.obligationId) ?? [];
      list.push(view);
      byObligation.set(view.obligationId, list);
    }
    return rows.map((row) => {
      // A long series is cut to its latest occurrences (open work is always among them); the
      // occurrences endpoint lists the full history.
      const all = byObligation.get(row.id) ?? [];
      const occurrencesForRow = all.length > OCCURRENCES_PER_OBLIGATION ? all.slice(-OCCURRENCES_PER_OBLIGATION) : all;
      return {
        id: row.id,
        contractId: row.contractId,
        title: row.title,
        description: row.description,
        category: row.category,
        owner: personOrNull(row.owner),
        reviewer: personOrNull(row.reviewer),
        priority: row.priority,
        criticality: row.criticality,
        evidenceRequired: row.evidenceRequired,
        recurrence: row.recurrence,
        dueDate: dateOnlyStrict(row.dueDate),
        recurrenceUntil: dateOnly(row.recurrenceUntil),
        generatedThrough: dateOnly(row.generatedThrough),
        notes: row.notes,
        cancelledAt: isoOrNull(row.cancelledAt),
        occurrences: occurrencesForRow,
        version: row.version,
      };
    });
  }

  private async occurrenceViews(
    organizationId: string,
    contract: LoadedContract,
    rows: readonly OccurrenceRow[],
    today: string,
    me: string,
  ): Promise<OccurrenceView[]> {
    const counts = await this.attachmentCounts(
      organizationId,
      'OBLIGATION_OCCURRENCE',
      rows.map((row) => row.id),
    );
    const manager = this.isManager(contract, 'contract.manage_obligations');
    return rows.map((row) => {
      const dueDate = dateOnlyStrict(row.dueDate);
      const open = OPEN_OCCURRENCE_STATUSES.includes(row.status);
      return {
        id: row.id,
        obligationId: row.obligationId,
        contractId: row.contractId,
        title: row.obligation.title,
        category: row.obligation.category,
        criticality: row.obligation.criticality,
        evidenceRequired: row.obligation.evidenceRequired,
        dueDate,
        status: open && dueDate < today ? 'OVERDUE' : row.status,
        owner: personOrNull(row.owner),
        completedAt: isoOrNull(row.completedAt),
        completedBy: personOrNull(row.completedBy),
        completionNote: row.completionNote,
        evidenceVersionId: visibleVersionId(contract, 'contract.financial.view', row.evidenceVersion),
        evidenceAttachments: counts.get(row.id) ?? 0,
        waivedReason: row.waivedReason,
        version: row.version,
        canWork:
          open &&
          contract.row.status !== 'CLOSED' &&
          (manager ||
            row.ownerMemberId === me ||
            row.obligation.ownerMemberId === me ||
            row.obligation.reviewerMemberId === me),
      };
    });
  }

  private async milestoneViews(
    organizationId: string,
    contract: LoadedContract,
    rows: readonly MilestoneRow[],
    today: string,
    me: string,
  ): Promise<MilestoneView[]> {
    const counts = await this.attachmentCounts(
      organizationId,
      'CONTRACT_MILESTONE',
      rows.map((row) => row.id),
    );
    const manager = this.isManager(contract, 'contract.manage_milestones');
    const approver = contract.level === 'FULL' && contract.can('contract.approve');
    return rows.map((row) => {
      const dueDate = dateOnlyStrict(row.dueDate);
      const open = OPEN_MILESTONE_STATUSES.includes(row.status);
      return {
        id: row.id,
        contractId: row.contractId,
        project: row.project === null ? null : { id: row.project.id, code: row.project.code, name: row.project.name },
        title: row.title,
        description: row.description,
        owner: personOrNull(row.owner),
        dueDate,
        status: open && dueDate < today ? 'OVERDUE' : row.status,
        approvalRequired: row.approvalRequired,
        submittedAt: isoOrNull(row.submittedAt),
        approvedAt: isoOrNull(row.approvedAt),
        approvedBy: personOrNull(row.approvedBy),
        completedAt: isoOrNull(row.completedAt),
        completedBy: personOrNull(row.completedBy),
        evidenceAttachments: counts.get(row.id) ?? 0,
        version: row.version,
        canWork:
          open &&
          contract.row.status !== 'CLOSED' &&
          (manager || row.ownerMemberId === me || (row.status === 'SUBMITTED' && approver)),
      };
    });
  }

  private async notifyWork(
    tx: TenantDb,
    organizationId: string,
    contract: LoadedContract,
    recipients: readonly (string | null)[],
    type: string,
    entityKey: string,
    title: string,
    actorMemberId: string,
  ): Promise<void> {
    await notifyMembers(
      tx,
      organizationId,
      recipients,
      {
        type,
        severity: 'INFO',
        entityType: 'contract',
        entityId: contract.row.id,
        params: {
          contractKey: contractKey(contract.row.year, contract.row.number),
          contractTitle: contract.row.title,
          itemTitle: title,
        },
        dedupeKey: `${type}:${entityKey}`,
      },
      async (principal) => (await loadContractForAccess(tx, principal, organizationId, contract.row.id)) !== null,
      actorMemberId,
    );
  }
}
