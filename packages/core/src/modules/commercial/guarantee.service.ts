import type { GuaranteeType, Prisma } from '@company-ops/db';
import type { CreateGuaranteeRequest, GuaranteeStatusRequest, UpdateGuaranteeRequest } from '@company-ops/validation';

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
import { daysBetween } from '../projects/business-date.js';
import {
  canViewContractFinancial,
  canViewTenderFinancial,
  loadContractForAccess,
  loadTenderForAccess,
  loadVisibleContract,
  loadVisibleTender,
} from './commercial-access.js';
import type { LoadedContract, LoadedTender } from './commercial-access.js';
import {
  announceCommercialChange,
  appendContractEvent,
  appendTenderEvent,
  assertActiveMembers,
  dateOnly,
  dateOnlyStrict,
  memberRefSelect,
  organizationToday,
  personOrNull,
} from './commercial-support.js';
import type { EventParams, PersonRef } from './commercial-support.js';
import { refreshContract } from './contract-refresh.js';
import { contractKey } from './engine/contract-state.js';
import { guaranteeStatus } from './engine/dates.js';
import { decimal, toMoney } from './engine/money.js';
import type { Money } from './engine/money.js';
import { CLOSED_TENDER_STATUSES, tenderKey } from './engine/tender-state.js';

type GuaranteeParent =
  | { readonly type: 'TENDER'; readonly loaded: LoadedTender }
  | { readonly type: 'CONTRACT'; readonly loaded: LoadedContract };

export interface GuaranteeView {
  readonly id: string;
  readonly parent: { readonly type: 'TENDER' | 'CONTRACT'; readonly id: string; readonly key: string };
  readonly type: GuaranteeType;
  readonly referenceNumber: string;
  readonly issuer: string;
  readonly beneficiary: string | null;
  readonly amount?: Money;
  readonly issueDate: string;
  readonly expiryDate: string;
  readonly releaseDate: string | null;
  readonly owner: PersonRef | null;
  readonly status: 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'RELEASED' | 'CANCELLED';
  readonly daysToExpiry: number;
  readonly notes: string | null;
  readonly documents: number;
  readonly version: number;
  readonly canManage: boolean;
}

const guaranteeSelect = {
  id: true,
  tenderId: true,
  contractId: true,
  type: true,
  referenceNumber: true,
  issuer: true,
  beneficiary: true,
  amount: true,
  currency: true,
  issueDate: true,
  expiryDate: true,
  releaseDate: true,
  ownerMemberId: true,
  status: true,
  notes: true,
  version: true,
  owner: { select: memberRefSelect },
} satisfies Prisma.GuaranteeSelect;
type GuaranteeRow = Prisma.GuaranteeGetPayload<{ select: typeof guaranteeSelect }>;

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

function financialVisible(parent: GuaranteeParent): boolean {
  return parent.type === 'TENDER' ? canViewTenderFinancial(parent.loaded) : canViewContractFinancial(parent.loaded);
}

function canManage(parent: GuaranteeParent): boolean {
  if (parent.loaded.level !== 'FULL') return false;
  if (parent.type === 'TENDER') {
    return !CLOSED_TENDER_STATUSES.includes(parent.loaded.row.status) && parent.loaded.can('tender.edit');
  }
  return parent.loaded.row.status !== 'CLOSED' && parent.loaded.can('contract.manage_guarantees');
}

function parentKey(parent: GuaranteeParent): string {
  return parent.type === 'TENDER'
    ? tenderKey(parent.loaded.row.year, parent.loaded.row.number)
    : contractKey(parent.loaded.row.year, parent.loaded.row.number);
}

/**
 * Bid securities, performance guarantees and similar instruments of exactly one tender or contract
 * (spec §42). The amount and the guarantee's documents follow the parent's financial permission;
 * EXPIRING is derived from the expiry date and the organization's today; EXPIRED is stored by the
 * commercial monitor; RELEASED and CANCELLED are explicit, audited decisions.
 */
export class GuaranteeService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listForTender(action: ActionContext, tenderId: string): Promise<GuaranteeView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const tender = await loadVisibleTender(this.db, action, organizationId, tenderId);
    return this.listFor(action, organizationId, { type: 'TENDER', loaded: tender }, { tenderId });
  }

  async listForContract(action: ActionContext, contractId: string): Promise<GuaranteeView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    return this.listFor(action, organizationId, { type: 'CONTRACT', loaded: contract }, { contractId });
  }

  async createForTender(
    action: ActionContext,
    tenderId: string,
    input: CreateGuaranteeRequest,
  ): Promise<GuaranteeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const tender = await loadVisibleTender(tx, action, organizationId, tenderId);
      return this.create(tx, action, organizationId, { type: 'TENDER', loaded: tender }, input);
    });
    return this.get(action, id);
  }

  async createForContract(
    action: ActionContext,
    contractId: string,
    input: CreateGuaranteeRequest,
  ): Promise<GuaranteeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const contract = await loadVisibleContract(tx, action, organizationId, contractId);
      await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
      return this.create(tx, action, organizationId, { type: 'CONTRACT', loaded: contract }, input);
    });
    return this.get(action, id);
  }

  async get(action: ActionContext, guaranteeId: string): Promise<GuaranteeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.guarantee.findFirst({
      where: { organizationId, id: guaranteeId },
      select: guaranteeSelect,
    });
    if (row === null) throw new NotFoundError('Guarantee');
    const parent = await this.parentOf(this.db, action, organizationId, row);
    if (parent === null || !this.mayRead(parent, row, action.principal.memberId)) throw new NotFoundError('Guarantee');
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    const [view] = await this.views(organizationId, parent, [row], today);
    if (view === undefined) throw new NotFoundError('Guarantee');
    return view;
  }

  async update(action: ActionContext, guaranteeId: string, input: UpdateGuaranteeRequest): Promise<GuaranteeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const { parent, row } = await this.loadManaged(tx, action, organizationId, guaranteeId);
      if (row.status === 'RELEASED' || row.status === 'CANCELLED') {
        throw new InvalidTransitionError(`A ${row.status} guarantee cannot be edited.`);
      }
      if ((input.amount !== undefined || input.currency !== undefined) && !financialVisible(parent)) {
        throw new ForbiddenError('Guarantee amounts need the financial permission.');
      }
      const issueDate = input.issueDate ?? dateOnlyStrict(row.issueDate);
      const expiryDate = input.expiryDate ?? dateOnlyStrict(row.expiryDate);
      if (expiryDate < issueDate)
        throw new InvalidInputError('expiryDate', 'The expiry date cannot precede the issue date.');
      const amount = input.amount !== undefined ? input.amount : (row.amount?.toString() ?? null);
      const currency = input.currency !== undefined ? input.currency : row.currency;
      if (amount !== null && currency === null)
        throw new InvalidInputError('currency', 'An amount needs its currency.');
      await assertActiveMembers(tx, organizationId, [['ownerMemberId', input.ownerMemberId]]);
      const data: Prisma.GuaranteeUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.referenceNumber !== undefined) data.referenceNumber = input.referenceNumber;
      if (input.issuer !== undefined) data.issuer = input.issuer;
      if (input.beneficiary !== undefined) data.beneficiary = input.beneficiary;
      if (input.amount !== undefined) data.amount = input.amount === null ? null : decimal(input.amount);
      if (input.currency !== undefined) data.currency = input.currency;
      if (input.issueDate !== undefined) data.issueDate = day(input.issueDate);
      if (input.expiryDate !== undefined) {
        data.expiryDate = day(input.expiryDate);
        const { today } = await organizationToday(tx, organizationId, this.clock());
        // A corrected or extended expiry reactivates a guarantee the monitor marked EXPIRED.
        if (row.status === 'EXPIRED' && input.expiryDate >= today) data.status = 'ACTIVE';
      }
      if (input.ownerMemberId !== undefined) data.ownerMemberId = input.ownerMemberId;
      if (input.notes !== undefined) data.notes = input.notes;
      const result = await tx.guarantee.updateMany({
        where: { organizationId, id: guaranteeId, version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Guarantee');
      await this.afterChange(tx, organizationId, parent, 'guarantee_updated', action.principal.memberId, {
        guaranteeId,
        referenceNumber: input.referenceNumber ?? row.referenceNumber,
        ...(input.expiryDate !== undefined && input.expiryDate !== dateOnlyStrict(row.expiryDate)
          ? { expiryDate: input.expiryDate }
          : {}),
      });
      await recordAudit(tx, organizationId, {
        action: 'guarantee.updated',
        entityType: 'guarantee',
        entityId: guaranteeId,
        actor: userActor(action),
        metadata: {
          parentType: parent.type,
          parentId: parent.loaded.row.id,
          fields: Object.keys(input).filter((key) => key !== 'version'),
        },
        context: action.request,
      });
    });
    return this.get(action, guaranteeId);
  }

  async changeStatus(
    action: ActionContext,
    guaranteeId: string,
    input: GuaranteeStatusRequest,
  ): Promise<GuaranteeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const { parent, row } = await this.loadManaged(tx, action, organizationId, guaranteeId);
      if (row.status === 'RELEASED' || row.status === 'CANCELLED') {
        throw new InvalidTransitionError(`The guarantee is already ${row.status}.`);
      }
      const { today } = await organizationToday(tx, organizationId, this.clock());
      const releaseDate = input.status === 'RELEASED' ? (input.releaseDate ?? today) : null;
      if (releaseDate !== null && releaseDate < dateOnlyStrict(row.issueDate)) {
        throw new InvalidInputError('releaseDate', 'The release date cannot precede the issue date.');
      }
      const result = await tx.guarantee.updateMany({
        where: { organizationId, id: guaranteeId, status: row.status, version: input.version },
        data: {
          status: input.status,
          releaseDate: releaseDate === null ? null : day(releaseDate),
          version: { increment: 1 },
        },
      });
      if (result.count === 0) throw new VersionConflictError('Guarantee');
      await this.afterChange(
        tx,
        organizationId,
        parent,
        input.status === 'RELEASED' ? 'guarantee_released' : 'guarantee_cancelled',
        action.principal.memberId,
        { guaranteeId, referenceNumber: row.referenceNumber },
      );
      await recordAudit(tx, organizationId, {
        action: input.status === 'RELEASED' ? 'guarantee.released' : 'guarantee.cancelled',
        entityType: 'guarantee',
        entityId: guaranteeId,
        actor: userActor(action),
        metadata: { parentType: parent.type, parentId: parent.loaded.row.id, from: row.status },
        context: action.request,
      });
    });
    return this.get(action, guaranteeId);
  }

  /** Attachment owner policy of GUARANTEE: documents follow the parent's financial permission. */
  async attachmentAccess(action: ActionContext, guaranteeId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const none = { canView: false, canUpload: false, canDelete: false };
    const row = await this.db.guarantee.findFirst({
      where: { organizationId, id: guaranteeId },
      select: guaranteeSelect,
    });
    if (row === null) return none;
    const parent = await this.parentOf(this.db, action, organizationId, row);
    if (parent === null || !financialVisible(parent)) return none;
    const open = row.status !== 'RELEASED' && row.status !== 'CANCELLED';
    return { canView: true, canUpload: open && canManage(parent), canDelete: false };
  }

  // ---- internals ----

  private async listFor(
    action: ActionContext,
    organizationId: string,
    parent: GuaranteeParent,
    where: Prisma.GuaranteeWhereInput,
  ): Promise<GuaranteeView[]> {
    const me = action.principal.memberId;
    const rows = await this.db.guarantee.findMany({
      where: { organizationId, ...where, ...(parent.loaded.level === 'FULL' ? {} : { ownerMemberId: me }) },
      orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
      take: 200,
      select: guaranteeSelect,
    });
    const { today } = await organizationToday(this.db, organizationId, this.clock());
    return this.views(organizationId, parent, rows, today);
  }

  private async create(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    parent: GuaranteeParent,
    input: CreateGuaranteeRequest,
  ): Promise<string> {
    if (!canManage(parent)) throw new ForbiddenError();
    if (input.amount != null && !financialVisible(parent))
      throw new ForbiddenError('Guarantee amounts need the financial permission.');
    await assertActiveMembers(tx, organizationId, [['ownerMemberId', input.ownerMemberId]]);
    const created = await tx.guarantee.create({
      data: {
        organizationId,
        tenderId: parent.type === 'TENDER' ? parent.loaded.row.id : null,
        contractId: parent.type === 'CONTRACT' ? parent.loaded.row.id : null,
        type: input.type,
        referenceNumber: input.referenceNumber,
        issuer: input.issuer,
        beneficiary: input.beneficiary ?? null,
        amount: input.amount == null ? null : decimal(input.amount),
        currency: input.currency ?? null,
        issueDate: day(input.issueDate),
        expiryDate: day(input.expiryDate),
        ownerMemberId: input.ownerMemberId ?? null,
        notes: input.notes ?? null,
        createdByMemberId: action.principal.memberId,
      },
      select: { id: true },
    });
    await this.afterChange(tx, organizationId, parent, 'guarantee_added', action.principal.memberId, {
      guaranteeId: created.id,
      type: input.type,
      referenceNumber: input.referenceNumber,
      expiryDate: input.expiryDate,
    });
    await recordAudit(tx, organizationId, {
      action: 'guarantee.created',
      entityType: 'guarantee',
      entityId: created.id,
      actor: userActor(action),
      metadata: { parentType: parent.type, parentId: parent.loaded.row.id, type: input.type },
      context: action.request,
    });
    return created.id;
  }

  private async afterChange(
    tx: TenantDb,
    organizationId: string,
    parent: GuaranteeParent,
    type: string,
    actorMemberId: string,
    params: EventParams,
  ): Promise<void> {
    if (parent.type === 'TENDER') {
      await appendTenderEvent(tx, organizationId, parent.loaded.row.id, `tender.${type}`, actorMemberId, params);
      await announceCommercialChange(tx, organizationId, 'tender', parent.loaded.row.id);
      return;
    }
    const { today } = await organizationToday(tx, organizationId, this.clock());
    await refreshContract(tx, organizationId, parent.loaded.row.id, today);
    await appendContractEvent(tx, organizationId, parent.loaded.row.id, `contract.${type}`, actorMemberId, params);
    await announceCommercialChange(tx, organizationId, 'contract', parent.loaded.row.id);
  }

  private async loadManaged(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    guaranteeId: string,
  ): Promise<{ parent: GuaranteeParent; row: GuaranteeRow }> {
    const row = await tx.guarantee.findFirst({ where: { organizationId, id: guaranteeId }, select: guaranteeSelect });
    if (row === null) throw new NotFoundError('Guarantee');
    const parent = await this.parentOf(tx, action, organizationId, row);
    if (parent === null || !this.mayRead(parent, row, action.principal.memberId)) throw new NotFoundError('Guarantee');
    if (!canManage(parent)) throw new ForbiddenError();
    if (parent.type === 'CONTRACT') await lockCommercialAggregate(tx, organizationId, 'contract', parent.loaded.row.id);
    return { parent, row };
  }

  private mayRead(parent: GuaranteeParent, row: { ownerMemberId: string | null }, me: string): boolean {
    return parent.loaded.level === 'FULL' || row.ownerMemberId === me;
  }

  private async parentOf(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    row: { tenderId: string | null; contractId: string | null },
  ): Promise<GuaranteeParent | null> {
    if (row.tenderId !== null) {
      const tender = await loadTenderForAccess(db, action.principal, organizationId, row.tenderId);
      return tender === null ? null : { type: 'TENDER', loaded: tender };
    }
    if (row.contractId !== null) {
      const contract = await loadContractForAccess(db, action.principal, organizationId, row.contractId);
      return contract === null ? null : { type: 'CONTRACT', loaded: contract };
    }
    return null;
  }

  private async views(
    organizationId: string,
    parent: GuaranteeParent,
    rows: readonly GuaranteeRow[],
    today: string,
  ): Promise<GuaranteeView[]> {
    const financial = financialVisible(parent);
    const documents = new Map<string, number>();
    if (financial && rows.length > 0) {
      const attachments = await this.db.attachment.findMany({
        where: {
          organizationId,
          ownerType: 'GUARANTEE',
          ownerId: { in: rows.map((row) => row.id) },
          status: 'AVAILABLE',
        },
        select: { ownerId: true },
        take: 2000,
      });
      for (const attachment of attachments)
        documents.set(attachment.ownerId, (documents.get(attachment.ownerId) ?? 0) + 1);
    }
    const manage = canManage(parent);
    const key = parentKey(parent);
    return rows.map((row) => {
      const expiryDate = dateOnlyStrict(row.expiryDate);
      const amount = financial ? toMoney(row.amount, row.currency) : undefined;
      return {
        id: row.id,
        parent: { type: parent.type, id: parent.loaded.row.id, key },
        type: row.type,
        referenceNumber: row.referenceNumber,
        issuer: row.issuer,
        beneficiary: row.beneficiary,
        ...(amount === undefined ? {} : { amount }),
        issueDate: dateOnlyStrict(row.issueDate),
        expiryDate,
        releaseDate: dateOnly(row.releaseDate),
        owner: personOrNull(row.owner),
        status: guaranteeStatus(row.status, expiryDate, today),
        daysToExpiry: daysBetween(today, expiryDate),
        notes: row.notes,
        documents: documents.get(row.id) ?? 0,
        version: row.version,
        canManage: manage && row.status !== 'RELEASED' && row.status !== 'CANCELLED',
      };
    });
  }
}
