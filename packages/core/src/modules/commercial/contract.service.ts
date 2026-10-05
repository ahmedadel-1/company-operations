import type { ContractStatus, Prisma, RenewalActionType } from '@company-ops/db';
import type {
  ContractListQuery,
  ContractTransitionRequest,
  CreateContractFromTenderRequest,
  CreateContractRequest,
  RenewalActionRequest,
  UpdateContractRequest,
} from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { escapeLike } from '../../platform/db/like.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { nextCounterValue } from '../../platform/db/sql/counters.js';
import { lockCommercialAggregate } from '../../platform/db/sql/locks.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  VersionConflictError,
} from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';
import type { Principal, ResourceFacts } from '../authorization/policy.js';
import { addDays } from '../projects/business-date.js';
import { loadProjectForAccess } from '../projects/project-access.js';
import {
  assertCan,
  canViewContractFinancial,
  canViewTenderFinancial,
  hiddenDocumentEventsWhere,
  loadContractForAccess,
  loadTenderForAccess,
  loadVisibleContract,
  loadVisibleTender,
  versionClassificationSelect,
  visibleContractWhere,
  visibleDocumentWhere,
  visibleVersionId,
} from './commercial-access.js';
import type { LoadedContract } from './commercial-access.js';
import { canManageCommercialDocuments } from './commercial-document.service.js';
import {
  announceCommercialChange,
  appendContractEvent,
  appendTenderEvent,
  assertActiveMembers,
  dateOnly,
  eventParams,
  iso,
  memberRefSelect,
  notifyMembers,
  organizationToday,
  personOrNull,
} from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { refreshContract } from './contract-refresh.js';
import type { ContractRefresh } from './contract-refresh.js';
import { contractRowFinancialVisible, contractSummarySelect, toContractSummary } from './contract-views.js';
import type { ContractSummaryView } from './contract-views.js';
import {
  CLOSED_CONTRACT_STATUSES,
  LIVE_CONTRACT_STATUSES,
  baselineEditable,
  checkContractTransition,
  contractKey,
  contractTargets,
  isRenewalDecision,
  renewalActionAllowed,
  startsNewTerm,
  statusAfterRenewalAction,
} from './engine/contract-state.js';
import {
  CONTRACT_EXPIRING_DAYS,
  GUARANTEE_EXPIRING_DAYS,
  NOTICE_APPROACHING_DAYS,
  noticeDeadline,
} from './engine/dates.js';
import { decimal, toMoney } from './engine/money.js';
import type { Money } from './engine/money.js';
import { tenderRefSelect, toTenderRef } from './tender-views.js';
import type { CommercialEventView } from './tender.service.js';

export interface ContractAccessView {
  readonly canEdit: boolean;
  readonly canApprove: boolean;
  readonly canManageDocuments: boolean;
  readonly canManageObligations: boolean;
  readonly canManageMilestones: boolean;
  readonly canManageGuarantees: boolean;
  readonly canManageAmendments: boolean;
  readonly canManageRenewal: boolean;
  readonly canViewFinancial: boolean;
  readonly canViewConfidentialDocuments: boolean;
  readonly transitions: ContractStatus[];
}

export interface ContractView extends ContractSummaryView {
  readonly accessLevel: 'FULL' | 'INVOLVED';
  readonly internalReference: string | null;
  readonly description: string | null;
  readonly sourceTender: ReturnType<typeof toTenderRef> | null;
  readonly contractType: ContractDetailRow['contractType'];
  readonly originalValue?: Money;
  readonly signedDate: string | null;
  readonly effectiveDate: string | null;
  readonly startDate: string | null;
  readonly originalExpiryDate: string | null;
  readonly initialTermMonths: number | null;
  readonly renewalType: ContractDetailRow['renewalType'];
  readonly noticePeriodDays: number | null;
  readonly renewalDecisionDate: string | null;
  readonly statusReason: string | null;
  readonly warrantyStartDate: string | null;
  readonly warrantyEndDate: string | null;
  readonly supportStartDate: string | null;
  readonly supportEndDate: string | null;
  readonly healthEvaluatedOn: string | null;
  readonly counts: {
    readonly overdueObligations: number;
    readonly upcomingObligations: number;
    readonly overdueMilestones: number;
    readonly activeGuarantees: number;
    readonly expiringGuarantees: number;
    readonly pendingAmendments: number;
  };
  readonly lastRenewalAction: { readonly action: RenewalActionType; readonly createdAt: string } | null;
  readonly createdAt: string;
  readonly createdBy: PersonRef | null;
  readonly access: ContractAccessView;
}

export interface RenewalActionView {
  readonly id: string;
  readonly action: RenewalActionType;
  readonly comment: string | null;
  readonly newExpiryDate: string | null;
  readonly documentVersionId: string | null;
  readonly actor: PersonRef | null;
  readonly createdAt: string;
}

const contractDetailSelect = {
  ...contractSummarySelect,
  internalReference: true,
  description: true,
  sourceTenderId: true,
  contractType: true,
  originalValue: true,
  signedDate: true,
  effectiveDate: true,
  startDate: true,
  originalExpiryDate: true,
  initialTermMonths: true,
  renewalType: true,
  noticePeriodDays: true,
  renewalDecisionDate: true,
  statusReason: true,
  warrantyStartDate: true,
  warrantyEndDate: true,
  supportStartDate: true,
  supportEndDate: true,
  healthEvaluatedOn: true,
  createdAt: true,
  createdBy: { select: memberRefSelect },
} satisfies Prisma.ContractSelect;
type ContractDetailRow = Prisma.ContractGetPayload<{ select: typeof contractDetailSelect }>;

const OPEN_OCCURRENCE: Prisma.ContractObligationOccurrenceWhereInput = { status: { in: ['UPCOMING', 'IN_PROGRESS'] } };
const OPEN_MILESTONE: Prisma.ContractMilestoneWhereInput = {
  status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'] },
};
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const toDay = (value: string | null | undefined): Date | null => (value == null ? null : day(value));

type DateFields = Pick<
  CreateContractRequest,
  | 'signedDate'
  | 'effectiveDate'
  | 'startDate'
  | 'initialTermMonths'
  | 'renewalType'
  | 'noticePeriodDays'
  | 'renewalDecisionDate'
  | 'warrantyStartDate'
  | 'warrantyEndDate'
  | 'supportStartDate'
  | 'supportEndDate'
>;

/**
 * Contracts (ADR-0026, spec §30-§37, §43-§46): the post-award agreement with an immutable baseline,
 * a projection of current value and expiry rebuilt from effective amendments and renewal actions,
 * explicit lifecycle transitions, renewal actions with evidence, and stored deterministic health.
 * Creating a contract from an awarded tender is idempotent (Idempotency-Key) without a global 1:1
 * rule between tenders and contracts.
 */
/**
 * Row filter of the contract list (visibility plus every list filter except paging), shared with the
 * dashboard so a number and the list it links to always agree. Null when no contract can be visible.
 */
export function contractListWhere(
  principal: Principal,
  query: Omit<ContractListQuery, 'cursor' | 'limit' | 'sort'>,
  today: string,
): Prisma.ContractWhereInput[] | null {
  const visible = visibleContractWhere(principal);
  if (visible === null) return null;
  const todayDate = day(today);
  const me = principal.memberId;
  const and: Prisma.ContractWhereInput[] = [visible];
  if (query.view === 'mine') {
    and.push({
      OR: [
        { ownerMemberId: me },
        { obligations: { some: { OR: [{ ownerMemberId: me }, { reviewerMemberId: me }] } } },
        { occurrences: { some: { ownerMemberId: me } } },
        { milestones: { some: { ownerMemberId: me } } },
        { guarantees: { some: { ownerMemberId: me } } },
      ],
    });
  }
  if (query.status !== undefined) and.push({ status: { in: [...query.status] } });
  if (query.health !== undefined) and.push({ health: { in: [...query.health] } });
  if (query.customerId !== undefined) and.push({ customerId: query.customerId });
  if (query.ownerMemberId !== undefined) and.push({ ownerMemberId: query.ownerMemberId });
  if (query.projectId !== undefined) and.push({ projectId: query.projectId });
  if (query.sourceTenderId !== undefined) and.push({ sourceTenderId: query.sourceTenderId });
  if (query.expiringWithinDays !== undefined) {
    and.push({
      status: { in: [...LIVE_CONTRACT_STATUSES] },
      currentExpiryDate: { gte: todayDate, lte: day(addDays(today, query.expiringWithinDays)) },
    });
  }
  if (query.renewalRequired === true) and.push(renewalRequiredWhere(today));
  if (query.noticeApproaching === true) and.push(noticeApproachingWhere(today));
  if (query.overdueObligations === true) {
    and.push({ occurrences: { some: { ...OPEN_OCCURRENCE, dueDate: { lt: todayDate } } } });
  }
  if (query.overdueMilestones === true) {
    and.push({ milestones: { some: { ...OPEN_MILESTONE, dueDate: { lt: todayDate } } } });
  }
  if (query.guaranteesExpiring === true) and.push(guaranteesExpiringWhere(today));
  if (query.q !== undefined) {
    const q = query.q.trim();
    const pattern = escapeLike(q);
    const numeric = /^(?:CTR-\d{4}-)?0*(\d{1,9})$/i.exec(q);
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

/** Not closed, with an ACTIVE guarantee expiring within the window (or already past it), or an EXPIRED one. */
export function guaranteesExpiringWhere(today: string): Prisma.ContractWhereInput {
  return {
    status: { notIn: [...CLOSED_CONTRACT_STATUSES] },
    guarantees: {
      some: {
        OR: [
          { status: 'EXPIRED' },
          { status: 'ACTIVE', expiryDate: { lte: day(addDays(today, GUARANTEE_EXPIRING_DAYS)) } },
        ],
      },
    },
  };
}

export class ContractService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext, query: ContractListQuery): Promise<Page<ContractSummaryView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const filter = contractListWhere(action.principal, query, today);
    if (filter === null) return { items: [], nextCursor: null };
    const size = pageSize(query.limit);
    const and: Prisma.ContractWhereInput[] = [...filter];
    const sort = query.sort ?? 'updatedAt:desc';
    let orderBy: Prisma.ContractOrderByWithRelationInput[];
    if (sort === 'number:desc') {
      orderBy = [{ number: 'desc' }];
      if (query.cursor !== undefined) {
        const [number = '0'] = decodeCursor(query.cursor, 1);
        and.push({ number: { lt: Number(number) } });
      }
    } else if (sort === 'expiry:asc') {
      orderBy = [{ currentExpiryDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
      if (query.cursor !== undefined) {
        const [expiry = '', id = ''] = decodeCursor(query.cursor, 2);
        if (expiry === '') {
          and.push({ currentExpiryDate: null, id: { gt: id } });
        } else {
          const at = day(expiry);
          and.push({
            OR: [
              { currentExpiryDate: { gt: at } },
              { currentExpiryDate: at, id: { gt: id } },
              { currentExpiryDate: null },
            ],
          });
        }
      }
    } else {
      orderBy = [{ updatedAt: 'desc' }, { id: 'desc' }];
      if (query.cursor !== undefined) {
        const [updatedAt = '', id = ''] = decodeCursor(query.cursor, 2);
        const at = new Date(updatedAt);
        and.push({ OR: [{ updatedAt: { lt: at } }, { updatedAt: at, id: { lt: id } }] });
      }
    }
    const rows = await this.db.contract.findMany({
      where: { organizationId, AND: and },
      orderBy,
      take: size + 1,
      select: contractSummarySelect,
    });
    const page = toPage(rows, size, (row) =>
      sort === 'number:desc'
        ? [String(row.number)]
        : sort === 'expiry:asc'
          ? [dateOnly(row.currentExpiryDate) ?? '', row.id]
          : [row.updatedAt.toISOString(), row.id],
    );
    return {
      items: page.items.map((row) =>
        toContractSummary(row, contractRowFinancialVisible(action.principal, organizationId, row), today),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async get(action: ActionContext, contractId: string): Promise<ContractView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    return this.view(action, organizationId, contract);
  }

  async create(action: ActionContext, input: CreateContractRequest): Promise<ContractView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    validateDates({ ...input, expiryDate: input.expiryDate ?? null });
    const facts = await proposedFacts(this.db, organizationId, input.ownerMemberId, input.projectId ?? null);
    if (!canAccessResource(action.principal, 'contract.create', facts)) throw new ForbiddenError();
    if (!canAccessResource(action.principal, 'contract.financial.view', facts)) {
      throw new ForbiddenError('Recording a contract value needs the contract financial permission.');
    }
    const id = await this.db.$transaction(async (tx) => {
      await this.validateReferences(
        tx,
        action,
        organizationId,
        input.customerId ?? null,
        input.projectId ?? null,
        input.ownerMemberId,
      );
      return this.insert(tx, action, organizationId, {
        title: input.title,
        internalReference: input.internalReference ?? null,
        description: input.description ?? null,
        customerId: input.customerId ?? null,
        counterpartyName: input.counterpartyName ?? null,
        projectId: input.projectId ?? null,
        sourceTenderId: null,
        contractType: input.contractType,
        currency: input.currency,
        originalValue: input.originalValue,
        expiryDate: input.expiryDate ?? null,
        ownerMemberId: input.ownerMemberId,
        idempotencyKey: null,
        dates: input,
      });
    });
    return this.get(action, id);
  }

  /** Creates a contract from an AWARDED tender with prefilled data; replays return the same contract. */
  async createFromTender(
    action: ActionContext,
    tenderId: string,
    input: CreateContractFromTenderRequest,
    idempotencyKey: string,
  ): Promise<ContractView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const replay = await this.db.contract.findFirst({
      where: { organizationId, idempotencyKey },
      select: { id: true, sourceTenderId: true },
    });
    if (replay !== null) {
      if (replay.sourceTenderId !== tenderId)
        throw new ConflictError('This Idempotency-Key was used for another operation.');
      return this.get(action, replay.id);
    }
    let id: string;
    try {
      id = await this.db.$transaction(async (tx) => {
        const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
        if (tender.level !== 'FULL') throw new ForbiddenError();
        if (tender.row.status !== 'AWARDED')
          throw new InvalidTransitionError('Contracts are created from awarded tenders.');
        const source = await tx.tender.findFirstOrThrow({
          where: { organizationId, id: tenderId },
          select: {
            title: true,
            customerId: true,
            counterpartyName: true,
            relatedProjectId: true,
            ownerMemberId: true,
            awardValue: true,
            awardCurrency: true,
            awardDate: true,
            estimatedValue: true,
            currency: true,
            internalReference: true,
          },
        });
        const tenderFinancial = canViewTenderFinancial(tender);
        const originalValue =
          input.originalValue ??
          (tenderFinancial ? (source.awardValue ?? source.estimatedValue)?.toString() : undefined);
        const currency = input.currency ?? (tenderFinancial ? (source.awardCurrency ?? source.currency) : null) ?? null;
        if (originalValue === undefined) throw new InvalidInputError('originalValue', 'Enter the contract value.');
        if (currency === null) throw new InvalidInputError('currency', 'Enter the contract currency.');
        const ownerMemberId = input.ownerMemberId ?? source.ownerMemberId;
        const projectId = input.projectId !== undefined ? input.projectId : source.relatedProjectId;
        const facts = await proposedFacts(tx, organizationId, ownerMemberId, projectId);
        if (!canAccessResource(action.principal, 'contract.create', facts)) throw new ForbiddenError();
        if (!canAccessResource(action.principal, 'contract.financial.view', facts)) {
          throw new ForbiddenError('Recording a contract value needs the contract financial permission.');
        }
        const expiryDate = input.expiryDate ?? null;
        validateDates({ ...input, expiryDate });
        await this.validateReferences(tx, action, organizationId, source.customerId, projectId, ownerMemberId);
        const created = await this.insert(tx, action, organizationId, {
          title: input.title ?? source.title,
          internalReference: source.internalReference,
          description: null,
          customerId: source.customerId,
          counterpartyName: source.counterpartyName,
          projectId,
          sourceTenderId: tenderId,
          contractType: input.contractType,
          currency,
          originalValue,
          expiryDate,
          ownerMemberId,
          idempotencyKey,
          dates: {
            ...input,
            signedDate: input.signedDate !== undefined ? input.signedDate : dateOnly(source.awardDate),
          },
        });
        const row = await tx.contract.findFirstOrThrow({
          where: { organizationId, id: created },
          select: { number: true, year: true },
        });
        await appendTenderEvent(tx, organizationId, tenderId, 'tender.contract_created', action.principal.memberId, {
          contractId: created,
          contractKey: contractKey(row.year, row.number),
        });
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.db.contract.findFirst({
          where: { organizationId, idempotencyKey },
          select: { id: true },
        });
        if (raced !== null) return this.get(action, raced.id);
      }
      throw error;
    }
    return this.get(action, id);
  }

  async update(action: ActionContext, contractId: string, input: UpdateContractRequest): Promise<ContractView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await loadVisibleContract(tx, action, organizationId, contractId);
      if (contract.level !== 'FULL') throw new ForbiddenError();
      assertCan(contract, 'contract.edit');
      await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
      if (CLOSED_CONTRACT_STATUSES.includes(contract.row.status)) {
        throw new InvalidTransitionError(`A ${contract.row.status} contract cannot be edited.`);
      }
      const current = await tx.contract.findFirstOrThrow({
        where: { organizationId, id: contractId },
        select: contractDetailSelect,
      });
      const baselineChange =
        input.currency !== undefined || input.originalValue !== undefined || input.expiryDate !== undefined;
      if (baselineChange && !baselineEditable(current.status)) {
        throw new InvalidTransitionError(
          'The baseline (currency, value, expiry) changes only in DRAFT; use an amendment or renewal.',
        );
      }
      if ((input.originalValue !== undefined || input.currency !== undefined) && !canViewContractFinancial(contract)) {
        throw new ForbiddenError('Changing the contract value needs the contract financial permission.');
      }
      const merged = {
        signedDate: pick(input.signedDate, dateOnly(current.signedDate)),
        effectiveDate: pick(input.effectiveDate, dateOnly(current.effectiveDate)),
        startDate: pick(input.startDate, dateOnly(current.startDate)),
        expiryDate: pick(input.expiryDate, dateOnly(current.originalExpiryDate)),
        renewalDecisionDate: pick(input.renewalDecisionDate, dateOnly(current.renewalDecisionDate)),
        warrantyStartDate: pick(input.warrantyStartDate, dateOnly(current.warrantyStartDate)),
        warrantyEndDate: pick(input.warrantyEndDate, dateOnly(current.warrantyEndDate)),
        supportStartDate: pick(input.supportStartDate, dateOnly(current.supportStartDate)),
        supportEndDate: pick(input.supportEndDate, dateOnly(current.supportEndDate)),
      };
      validateDates(merged);
      const ownerMemberId = input.ownerMemberId ?? current.ownerMemberId;
      const projectId = input.projectId !== undefined ? input.projectId : current.projectId;
      if (ownerMemberId !== current.ownerMemberId || projectId !== current.projectId) {
        const facts = await proposedFacts(tx, organizationId, ownerMemberId, projectId);
        if (!canAccessResource(action.principal, 'contract.edit', facts)) {
          throw new ForbiddenError('The change would move the contract outside what you may edit.');
        }
      }
      await this.validateReferences(
        tx,
        action,
        organizationId,
        input.customerId !== undefined ? input.customerId : null,
        input.projectId !== undefined ? input.projectId : null,
        input.ownerMemberId,
      );
      const data: Prisma.ContractUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.title !== undefined) data.title = input.title;
      if (input.internalReference !== undefined) data.internalReference = input.internalReference;
      if (input.description !== undefined) data.description = input.description;
      if (input.customerId !== undefined) data.customerId = input.customerId;
      if (input.counterpartyName !== undefined) data.counterpartyName = input.counterpartyName;
      if (input.projectId !== undefined) data.projectId = input.projectId;
      if (input.contractType !== undefined) data.contractType = input.contractType;
      if (input.ownerMemberId !== undefined) data.ownerMemberId = input.ownerMemberId;
      if (input.currency !== undefined) data.currency = input.currency;
      if (input.originalValue !== undefined) data.originalValue = decimal(input.originalValue);
      if (input.expiryDate !== undefined) data.originalExpiryDate = toDay(input.expiryDate);
      Object.assign(data, dateData(input));
      const result = await tx.contract.updateMany({
        where: { organizationId, id: contractId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Contract');
      const { today } = await organizationToday(tx, organizationId, this.clock());
      const refresh = await refreshContract(tx, organizationId, contractId, today);
      const me = action.principal.memberId;
      const fields = Object.keys(input).filter((key) => key !== 'version');
      await appendContractEvent(tx, organizationId, contractId, 'contract.updated', me, { fields: fields.join(',') });
      if (input.projectId !== undefined && input.projectId !== current.projectId) {
        await appendContractEvent(
          tx,
          organizationId,
          contractId,
          input.projectId === null ? 'contract.project_unlinked' : 'contract.project_linked',
          me,
          {
            projectId: input.projectId ?? current.projectId,
          },
        );
      }
      if (input.ownerMemberId !== undefined && input.ownerMemberId !== current.ownerMemberId) {
        await appendContractEvent(tx, organizationId, contractId, 'contract.owner_changed', me, {});
      }
      await this.recordProjectionEvents(tx, organizationId, contractId, me, refresh);
      await recordAudit(tx, organizationId, {
        action: 'contract.updated',
        entityType: 'contract',
        entityId: contractId,
        actor: userActor(action),
        metadata: { fields },
        context: action.request,
      });
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    return this.get(action, contractId);
  }

  async transition(action: ActionContext, contractId: string, input: ContractTransitionRequest): Promise<ContractView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await loadVisibleContract(tx, action, organizationId, contractId);
      if (contract.level !== 'FULL') throw new ForbiddenError();
      const from = contract.row.status;
      const check = checkContractTransition(from, input.to);
      if (!check.ok) throw new InvalidTransitionError(`A contract cannot move from ${from} to ${input.to}.`);
      assertCan(contract, check.permission);
      if (check.needsReason && input.reason === undefined)
        throw new InvalidInputError('reason', 'A reason is required.');
      await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
      const result = await tx.contract.updateMany({
        where: { organizationId, id: contractId, status: from, version: input.version },
        data: { status: input.to, statusReason: input.reason ?? null, version: { increment: 1 } },
      });
      if (result.count === 0) throw new VersionConflictError('Contract');
      const { today } = await organizationToday(tx, organizationId, this.clock());
      await refreshContract(tx, organizationId, contractId, today);
      const me = action.principal.memberId;
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        input.to === 'ACTIVE' && from === 'AWAITING_SIGNATURE' ? 'contract.activated' : 'contract.status_changed',
        me,
        {
          from,
          to: input.to,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.status_changed',
        entityType: 'contract',
        entityId: contractId,
        actor: userActor(action),
        metadata: { from, to: input.to },
        context: action.request,
      });
      if (
        input.to === 'AWAITING_SIGNATURE' ||
        input.to === 'ACTIVE' ||
        input.to === 'TERMINATED' ||
        input.to === 'SUSPENDED'
      ) {
        await notifyMembers(
          tx,
          organizationId,
          [contract.row.ownerMemberId],
          {
            type: 'CONTRACT_STATUS_CHANGED',
            severity: input.to === 'TERMINATED' || input.to === 'SUSPENDED' ? 'WARNING' : 'INFO',
            entityType: 'contract',
            entityId: contractId,
            params: {
              contractKey: contractKey(contract.row.year, contract.row.number),
              contractTitle: contract.row.title,
              status: input.to,
            },
            dedupeKey: `CONTRACT_STATUS_CHANGED:${contractId}:${String(input.version + 1)}`,
          },
          async (principal) => (await loadContractForAccess(tx, principal, organizationId, contractId)) !== null,
          me,
        );
      }
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    return this.get(action, contractId);
  }

  /**
   * Records a renewal decision or action (spec §43-§44). Decisions (RENEW / DO_NOT_RENEW) never move a
   * legal date; RENEWED / EXTENDED with a new expiry start a new term through the projection and
   * reactivate an expired or in-review contract. Idempotent per Idempotency-Key.
   */
  async recordRenewalAction(
    action: ActionContext,
    contractId: string,
    input: RenewalActionRequest,
    idempotencyKey: string,
  ): Promise<ContractView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const replay = await this.db.contractRenewalAction.findFirst({
      where: { organizationId, contractId, idempotencyKey },
      select: { id: true },
    });
    if (replay !== null) return this.get(action, contractId);
    try {
      await this.db.$transaction(async (tx) => {
        const contract = await loadVisibleContract(tx, action, organizationId, contractId);
        if (contract.level !== 'FULL') throw new ForbiddenError();
        assertCan(contract, 'contract.manage_renewal');
        await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
        const current = await tx.contract.findFirstOrThrow({
          where: { organizationId, id: contractId },
          select: { status: true, version: true, currentExpiryDate: true, renewalType: true },
        });
        if (current.version !== input.version) throw new VersionConflictError('Contract');
        if (!renewalActionAllowed(current.status)) {
          throw new InvalidTransitionError(`Renewal actions are not recorded while the contract is ${current.status}.`);
        }
        const newTerm = startsNewTerm(input.action);
        const newExpiry = input.newExpiryDate ?? null;
        if (newTerm && newExpiry === null)
          throw new InvalidInputError('newExpiryDate', 'A renewal or extension needs the new expiry date.');
        if (!newTerm && newExpiry !== null)
          throw new InvalidInputError('newExpiryDate', 'Only a renewal or extension changes the expiry date.');
        const currentExpiry = dateOnly(current.currentExpiryDate);
        if (newExpiry !== null && currentExpiry !== null && newExpiry <= currentExpiry) {
          throw new InvalidInputError('newExpiryDate', 'The new expiry must be after the current expiry.');
        }
        if (input.action === 'REVIEW_STARTED' && current.status !== 'ACTIVE') {
          throw new InvalidTransitionError('A renewal review starts from an active contract.');
        }
        if (input.documentVersionId != null) {
          const version = await tx.commercialDocumentVersion.findFirst({
            where: {
              organizationId,
              id: input.documentVersionId,
              document: { contractId, ...visibleDocumentWhere(contract, 'contract.financial.view') },
            },
            select: { id: true },
          });
          if (version === null)
            throw new InvalidInputError('documentVersionId', 'Unknown document version of this contract.');
        }
        const now = this.clock();
        const { today } = await organizationToday(tx, organizationId, now);
        const status = statusAfterRenewalAction(current.status, input.action, newExpiry, today);
        const data: Prisma.ContractUncheckedUpdateManyInput = { status, version: { increment: 1 } };
        if (isRenewalDecision(input.action)) {
          data.renewalDecision = input.action;
          data.renewalDecidedAt = now;
        }
        if (newTerm) {
          data.renewalDecision = null;
          data.renewalDecidedAt = null;
        }
        const result = await tx.contract.updateMany({
          where: { organizationId, id: contractId, version: input.version },
          data,
        });
        if (result.count === 0) throw new VersionConflictError('Contract');
        await tx.contractRenewalAction.create({
          data: {
            organizationId,
            contractId,
            action: input.action,
            comment: input.comment ?? null,
            newExpiryDate: toDay(newExpiry),
            documentVersionId: input.documentVersionId ?? null,
            idempotencyKey,
            contractVersion: input.version + 1,
            actorMemberId: action.principal.memberId,
            createdAt: now,
          },
          select: { id: true },
        });
        const refresh = await refreshContract(tx, organizationId, contractId, today);
        const me = action.principal.memberId;
        await appendContractEvent(
          tx,
          organizationId,
          contractId,
          input.action === 'REVIEW_STARTED' ? 'contract.renewal_review_started' : 'contract.renewal_action_recorded',
          me,
          { action: input.action, ...(newExpiry === null ? {} : { newExpiryDate: newExpiry }) },
        );
        if (status !== current.status) {
          await appendContractEvent(tx, organizationId, contractId, 'contract.status_changed', me, {
            from: current.status,
            to: status,
          });
        }
        await this.recordProjectionEvents(tx, organizationId, contractId, me, refresh);
        await recordAudit(tx, organizationId, {
          action: 'contract.renewal_action_recorded',
          entityType: 'contract',
          entityId: contractId,
          actor: userActor(action),
          metadata: { action: input.action, newExpiryDate: newExpiry, from: current.status, to: status },
          context: action.request,
        });
        await announceCommercialChange(tx, organizationId, 'contract', contractId);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.db.contractRenewalAction.findFirst({
          where: { organizationId, contractId, idempotencyKey },
          select: { id: true },
        });
        if (raced !== null) return this.get(action, contractId);
      }
      throw error;
    }
    return this.get(action, contractId);
  }

  async listRenewalActions(action: ActionContext, contractId: string): Promise<RenewalActionView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    if (contract.level !== 'FULL') return [];
    const rows = await this.db.contractRenewalAction.findMany({
      where: { organizationId, contractId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      select: {
        id: true,
        action: true,
        comment: true,
        newExpiryDate: true,
        documentVersion: versionClassificationSelect,
        createdAt: true,
        actor: { select: memberRefSelect },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      comment: row.comment,
      newExpiryDate: dateOnly(row.newExpiryDate),
      documentVersionId: visibleVersionId(contract, 'contract.financial.view', row.documentVersion),
      actor: personOrNull(row.actor),
      createdAt: iso(row.createdAt),
    }));
  }

  async timeline(
    action: ActionContext,
    contractId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<Page<CommercialEventView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    const size = pageSize(limit);
    const and: Prisma.ContractEventWhereInput[] = [];
    const hidden = await hiddenDocumentEventsWhere(this.db, organizationId, { type: 'CONTRACT', loaded: contract });
    if (hidden !== null) and.push(hidden);
    if (cursor !== undefined) {
      const [createdAt = '', id = ''] = decodeCursor(cursor, 2);
      const at = new Date(createdAt);
      and.push({ OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: id } }] });
    }
    const rows = await this.db.contractEvent.findMany({
      where: { organizationId, contractId, AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: { id: true, type: true, metadata: true, createdAt: true, actor: { select: memberRefSelect } },
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    const financial = canViewContractFinancial(contract);
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

  async memberCanView(organizationId: string, principal: Principal, contractId: string): Promise<boolean> {
    return (await loadContractForAccess(this.db, principal, organizationId, contractId)) !== null;
  }

  // ---- internals ----

  private async insert(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    values: {
      title: string;
      internalReference: string | null;
      description: string | null;
      customerId: string | null;
      counterpartyName: string | null;
      projectId: string | null;
      sourceTenderId: string | null;
      contractType: CreateContractRequest['contractType'];
      currency: string;
      originalValue: string;
      expiryDate: string | null;
      ownerMemberId: string;
      idempotencyKey: string | null;
      dates: DateFields;
    },
  ): Promise<string> {
    const { today } = await organizationToday(tx, organizationId, this.clock());
    const number = Number(await nextCounterValue(tx, organizationId, 'CTR'));
    const value = decimal(values.originalValue);
    const notice = noticeDeadline(values.expiryDate, values.dates.noticePeriodDays ?? null);
    const created = await tx.contract.create({
      data: {
        organizationId,
        number,
        year: Number(today.slice(0, 4)),
        title: values.title,
        internalReference: values.internalReference,
        description: values.description,
        customerId: values.customerId,
        counterpartyName: values.counterpartyName,
        sourceTenderId: values.sourceTenderId,
        projectId: values.projectId,
        contractType: values.contractType,
        currency: values.currency,
        originalValue: value,
        currentValue: value,
        originalExpiryDate: toDay(values.expiryDate),
        currentExpiryDate: toDay(values.expiryDate),
        renewalNoticeDeadline: toDay(notice),
        ownerMemberId: values.ownerMemberId,
        idempotencyKey: values.idempotencyKey,
        createdByMemberId: action.principal.memberId,
        ...dateData(values.dates),
      },
      select: { id: true },
    });
    await refreshContract(tx, organizationId, created.id, today);
    const key = contractKey(Number(today.slice(0, 4)), number);
    await appendContractEvent(
      tx,
      organizationId,
      created.id,
      'contract.created',
      action.principal.memberId,
      { key, ...(values.sourceTenderId === null ? {} : { sourceTenderId: values.sourceTenderId }) },
      { originalValue: values.originalValue, currency: values.currency },
    );
    await recordAudit(tx, organizationId, {
      action: 'contract.created',
      entityType: 'contract',
      entityId: created.id,
      actor: userActor(action),
      metadata: { number, sourceTenderId: values.sourceTenderId },
      context: action.request,
    });
    await announceCommercialChange(tx, organizationId, 'contract', created.id);
    return created.id;
  }

  private async recordProjectionEvents(
    tx: TenantDb,
    organizationId: string,
    contractId: string,
    actorMemberId: string | null,
    refresh: ContractRefresh,
  ): Promise<void> {
    if (refresh.previousValue !== refresh.currentValue) {
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        'contract.value_changed',
        actorMemberId,
        {},
        {
          previousValue: refresh.previousValue,
          currentValue: refresh.currentValue,
        },
      );
    }
    if (refresh.previousExpiryDate !== refresh.currentExpiryDate) {
      await appendContractEvent(tx, organizationId, contractId, 'contract.expiry_changed', actorMemberId, {
        previousExpiryDate: refresh.previousExpiryDate,
        currentExpiryDate: refresh.currentExpiryDate,
      });
    }
  }

  private async validateReferences(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    customerId: string | null,
    projectId: string | null,
    ownerMemberId: string | undefined,
  ): Promise<void> {
    if (customerId !== null) {
      const customer = await tx.customer.findFirst({
        where: { organizationId, id: customerId },
        select: { archivedAt: true },
      });
      if (customer === null) throw new InvalidInputError('customerId', 'Unknown customer.');
      if (customer.archivedAt !== null) throw new InvalidInputError('customerId', 'The customer is archived.');
    }
    if (projectId !== null) {
      const project = await loadProjectForAccess(tx, organizationId, projectId);
      if (project === null || !canAccessResource(action.principal, 'project.view', project.facts)) {
        throw new InvalidInputError('projectId', 'Unknown project.');
      }
    }
    await assertActiveMembers(tx, organizationId, [['ownerMemberId', ownerMemberId]]);
  }

  private async view(action: ActionContext, organizationId: string, contract: LoadedContract): Promise<ContractView> {
    const db = this.db;
    const row = await db.contract.findFirstOrThrow({
      where: { organizationId, id: contract.row.id },
      select: contractDetailSelect,
    });
    const { today } = await organizationToday(db, organizationId, this.clock());
    const todayDate = day(today);
    const financial = canViewContractFinancial(contract);
    const full = contract.level === 'FULL';
    const can = (permission: Parameters<LoadedContract['can']>[0]): boolean => full && contract.can(permission);
    const contractId = row.id;
    const [
      overdueObligations,
      upcomingObligations,
      overdueMilestones,
      activeGuarantees,
      expiringGuarantees,
      pendingAmendments,
      lastRenewal,
    ] = await Promise.all([
      db.contractObligationOccurrence.count({
        where: { organizationId, contractId, ...OPEN_OCCURRENCE, dueDate: { lt: todayDate } },
      }),
      db.contractObligationOccurrence.count({
        where: {
          organizationId,
          contractId,
          ...OPEN_OCCURRENCE,
          dueDate: { gte: todayDate, lte: day(addDays(today, 30)) },
        },
      }),
      db.contractMilestone.count({
        where: { organizationId, contractId, ...OPEN_MILESTONE, dueDate: { lt: todayDate } },
      }),
      db.guarantee.count({ where: { organizationId, contractId, status: 'ACTIVE' } }),
      db.guarantee.count({
        where: {
          organizationId,
          contractId,
          status: 'ACTIVE',
          expiryDate: { gte: todayDate, lte: day(addDays(today, GUARANTEE_EXPIRING_DAYS)) },
        },
      }),
      db.contractAmendment.count({
        where: { organizationId, contractId, status: { in: ['DRAFT', 'UNDER_REVIEW', 'APPROVED'] } },
      }),
      db.contractRenewalAction.findFirst({
        where: { organizationId, contractId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { action: true, createdAt: true },
      }),
    ]);
    let sourceTender: ContractView['sourceTender'] = null;
    if (
      row.sourceTenderId !== null &&
      (await loadTenderForAccess(db, action.principal, organizationId, row.sourceTenderId)) !== null
    ) {
      const tender = await db.tender.findFirst({
        where: { organizationId, id: row.sourceTenderId },
        select: tenderRefSelect,
      });
      sourceTender = tender === null ? null : toTenderRef(tender);
    }
    const original = financial ? toMoney(row.originalValue, row.currency) : undefined;
    const open = !CLOSED_CONTRACT_STATUSES.includes(row.status);
    const editableChildren = row.status !== 'CLOSED';
    return {
      ...toContractSummary(row, financial, today),
      accessLevel: contract.level,
      internalReference: row.internalReference,
      description: row.description,
      sourceTender,
      contractType: row.contractType,
      ...(original === undefined ? {} : { originalValue: original }),
      signedDate: dateOnly(row.signedDate),
      effectiveDate: dateOnly(row.effectiveDate),
      startDate: dateOnly(row.startDate),
      originalExpiryDate: dateOnly(row.originalExpiryDate),
      initialTermMonths: row.initialTermMonths,
      renewalType: row.renewalType,
      noticePeriodDays: row.noticePeriodDays,
      renewalDecisionDate: dateOnly(row.renewalDecisionDate),
      statusReason: row.statusReason,
      warrantyStartDate: dateOnly(row.warrantyStartDate),
      warrantyEndDate: dateOnly(row.warrantyEndDate),
      supportStartDate: dateOnly(row.supportStartDate),
      supportEndDate: dateOnly(row.supportEndDate),
      healthEvaluatedOn: dateOnly(row.healthEvaluatedOn),
      counts: {
        overdueObligations,
        upcomingObligations,
        overdueMilestones,
        activeGuarantees,
        expiringGuarantees,
        pendingAmendments,
      },
      lastRenewalAction:
        lastRenewal === null ? null : { action: lastRenewal.action, createdAt: iso(lastRenewal.createdAt) },
      createdAt: iso(row.createdAt),
      createdBy: personOrNull(row.createdBy),
      access: {
        canEdit: open && can('contract.edit'),
        canApprove: can('contract.approve'),
        canManageDocuments: canManageCommercialDocuments({ type: 'CONTRACT', loaded: contract }),
        canManageObligations: editableChildren && can('contract.manage_obligations'),
        canManageMilestones: editableChildren && can('contract.manage_milestones'),
        canManageGuarantees: editableChildren && can('contract.manage_guarantees'),
        canManageAmendments: open && can('contract.manage_amendments'),
        canManageRenewal: renewalActionAllowed(row.status) && can('contract.manage_renewal'),
        canViewFinancial: financial,
        canViewConfidentialDocuments: can('commercial_document.view'),
        transitions: contractTargets(row.status).filter((to) => {
          const check = checkContractTransition(row.status, to);
          return check.ok && can(check.permission);
        }),
      },
    };
  }
}

/** Renewal decision needed: renewable type, no decision for the current term, expiry within 90 days. */
export function renewalRequiredWhere(today: string): Prisma.ContractWhereInput {
  return {
    status: { in: [...LIVE_CONTRACT_STATUSES] },
    renewalType: { in: ['MANUAL_RENEWAL', 'AUTO_RENEWAL'] },
    renewalDecision: null,
    currentExpiryDate: { gte: day(today), lte: day(addDays(today, CONTRACT_EXPIRING_DAYS)) },
  };
}

/** Undecided renewable contracts whose notice deadline falls within the next 30 days. */
export function noticeApproachingWhere(today: string): Prisma.ContractWhereInput {
  return {
    status: { in: [...LIVE_CONTRACT_STATUSES] },
    renewalType: { in: ['MANUAL_RENEWAL', 'AUTO_RENEWAL'] },
    renewalDecision: null,
    renewalNoticeDeadline: { gte: day(today), lte: day(addDays(today, NOTICE_APPROACHING_DAYS)) },
  };
}

/** `undefined` keeps the current value; an explicit `null` clears it (so not `??`). */
function pick<T>(value: T | undefined, fallback: T): T {
  if (value === undefined) return fallback;
  return value;
}

interface ContractDateColumns {
  signedDate?: Date | null;
  effectiveDate?: Date | null;
  startDate?: Date | null;
  initialTermMonths?: number | null;
  renewalType?: NonNullable<DateFields['renewalType']>;
  noticePeriodDays?: number | null;
  renewalDecisionDate?: Date | null;
  warrantyStartDate?: Date | null;
  warrantyEndDate?: Date | null;
  supportStartDate?: Date | null;
  supportEndDate?: Date | null;
}

function dateData(input: Partial<DateFields>): ContractDateColumns {
  const data: ContractDateColumns = {};
  if (input.signedDate !== undefined) data.signedDate = toDay(input.signedDate);
  if (input.effectiveDate !== undefined) data.effectiveDate = toDay(input.effectiveDate);
  if (input.startDate !== undefined) data.startDate = toDay(input.startDate);
  if (input.initialTermMonths !== undefined) data.initialTermMonths = input.initialTermMonths;
  if (input.renewalType !== undefined) data.renewalType = input.renewalType;
  if (input.noticePeriodDays !== undefined) data.noticePeriodDays = input.noticePeriodDays;
  if (input.renewalDecisionDate !== undefined) data.renewalDecisionDate = toDay(input.renewalDecisionDate);
  if (input.warrantyStartDate !== undefined) data.warrantyStartDate = toDay(input.warrantyStartDate);
  if (input.warrantyEndDate !== undefined) data.warrantyEndDate = toDay(input.warrantyEndDate);
  if (input.supportStartDate !== undefined) data.supportStartDate = toDay(input.supportStartDate);
  if (input.supportEndDate !== undefined) data.supportEndDate = toDay(input.supportEndDate);
  return data;
}

/** Date-pair rules: ranges are ordered; the term starts before it expires; decisions precede expiry. */
function validateDates(input: {
  effectiveDate?: string | null | undefined;
  startDate?: string | null | undefined;
  expiryDate: string | null;
  renewalDecisionDate?: string | null | undefined;
  warrantyStartDate?: string | null | undefined;
  warrantyEndDate?: string | null | undefined;
  supportStartDate?: string | null | undefined;
  supportEndDate?: string | null | undefined;
}): void {
  const before = (
    field: string,
    earlier: string | null | undefined,
    later: string | null | undefined,
    message: string,
  ): void => {
    if (earlier != null && later != null && earlier > later) throw new InvalidInputError(field, message);
  };
  before('expiryDate', input.startDate, input.expiryDate, 'The expiry cannot precede the start date.');
  before('expiryDate', input.effectiveDate, input.expiryDate, 'The expiry cannot precede the effective date.');
  before(
    'renewalDecisionDate',
    input.renewalDecisionDate,
    input.expiryDate,
    'The renewal decision date must precede the expiry.',
  );
  before('warrantyEndDate', input.warrantyStartDate, input.warrantyEndDate, 'The warranty ends before it starts.');
  before('supportEndDate', input.supportStartDate, input.supportEndDate, 'Support ends before it starts.');
}

async function proposedFacts(
  db: TenantDb,
  organizationId: string,
  ownerMemberId: string,
  projectId: string | null,
): Promise<ResourceFacts> {
  const owner = await db.organizationMember.findFirst({
    where: { organizationId, id: ownerMemberId },
    select: { profile: { select: { departmentId: true } } },
  });
  const department = owner?.profile?.departmentId ?? null;
  return {
    organizationId,
    ownerMemberIds: [ownerMemberId],
    subjectMemberIds: [ownerMemberId],
    departmentIds: department === null ? [] : [department],
    projectIds: projectId === null ? [] : [projectId],
  };
}
