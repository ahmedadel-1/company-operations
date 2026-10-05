import type { ContractAmendmentStatus, ContractAmendmentType, Prisma } from '@company-ops/db';
import type { AmendmentActionRequest, CreateAmendmentRequest, UpdateAmendmentRequest } from '@company-ops/validation';

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
import { canAccessResource } from '../authorization/policy.js';
import {
  assertCan,
  canViewContractFinancial,
  loadVisibleContract,
  versionClassificationSelect,
  visibleDocumentWhere,
  visibleVersionId,
} from './commercial-access.js';
import type { LoadedContract } from './commercial-access.js';
import {
  announceCommercialChange,
  appendContractEvent,
  dateOnly,
  dateOnlyStrict,
  iso,
  isoOrNull,
  memberRefSelect,
  notifyMembers,
  organizationToday,
  permissionHolderIds,
  personOrNull,
} from './commercial-support.js';
import type { PersonRef } from './commercial-support.js';
import { refreshContract } from './contract-refresh.js';
import type { ContractRefresh } from './contract-refresh.js';
import { amendmentKey, contractKey } from './engine/contract-state.js';
import { decimal, toMoney } from './engine/money.js';
import type { Money } from './engine/money.js';

export interface AmendmentView {
  readonly id: string;
  readonly contractId: string;
  readonly number: number;
  readonly key: string;
  readonly type: ContractAmendmentType;
  readonly title: string;
  readonly description: string | null;
  readonly effectiveDate: string;
  readonly valueDelta?: Money;
  readonly hasValueChange: boolean;
  readonly newExpiryDate: string | null;
  readonly scopeChangeSummary: string | null;
  readonly status: ContractAmendmentStatus;
  readonly submittedAt: string | null;
  readonly approvedAt: string | null;
  readonly approvedBy: PersonRef | null;
  readonly rejectionReason: string | null;
  readonly activatedAt: string | null;
  readonly activatedBy: PersonRef | null;
  readonly documentVersionId: string | null;
  readonly createdBy: PersonRef | null;
  readonly createdAt: string;
  readonly version: number;
  readonly access: {
    readonly canEdit: boolean;
    readonly canSubmit: boolean;
    readonly canApprove: boolean;
    readonly canActivate: boolean;
    readonly canCancel: boolean;
  };
}

const amendmentSelect = {
  id: true,
  contractId: true,
  number: true,
  type: true,
  title: true,
  description: true,
  effectiveDate: true,
  valueDelta: true,
  currency: true,
  newExpiryDate: true,
  scopeChangeSummary: true,
  status: true,
  submittedAt: true,
  approvedAt: true,
  rejectionReason: true,
  activatedAt: true,
  documentVersion: versionClassificationSelect,
  createdByMemberId: true,
  createdAt: true,
  version: true,
  approvedBy: { select: memberRefSelect },
  activatedBy: { select: memberRefSelect },
  createdBy: { select: memberRefSelect },
} satisfies Prisma.ContractAmendmentSelect;
type AmendmentRow = Prisma.ContractAmendmentGetPayload<{ select: typeof amendmentSelect }>;

/** Contracts that can be amended: signed and not closed. */
const AMENDABLE = ['ACTIVE', 'RENEWAL_REVIEW', 'SUSPENDED', 'EXPIRED'] as const;
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/**
 * Contract amendments (spec §36-§37): DRAFT -> UNDER_REVIEW -> APPROVED -> EFFECTIVE, or REJECTED /
 * CANCELLED. Approval is four-eyes (`contract.approve`, never the amendment's author). Only EFFECTIVE
 * amendments change the projection: activation takes the contract's aggregate lock, bumps its version
 * with an optimistic check and rebuilds the projection from the baseline, so concurrent activations
 * serialize and never apply on a stale base. Value deltas follow `contract.financial.view`.
 */
export class AmendmentService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext, contractId: string): Promise<AmendmentView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    if (contract.level !== 'FULL') return [];
    const rows = await this.db.contractAmendment.findMany({
      where: { organizationId, contractId },
      orderBy: [{ number: 'desc' }],
      take: 200,
      select: amendmentSelect,
    });
    return rows.map((row) => this.toView(row, contract, action.principal.memberId));
  }

  async get(action: ActionContext, contractId: string, amendmentId: string): Promise<AmendmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const contract = await loadVisibleContract(this.db, action, organizationId, contractId);
    if (contract.level !== 'FULL') throw new NotFoundError('Amendment');
    const row = await this.db.contractAmendment.findFirst({
      where: { organizationId, contractId, id: amendmentId },
      select: amendmentSelect,
    });
    if (row === null) throw new NotFoundError('Amendment');
    return this.toView(row, contract, action.principal.memberId);
  }

  async create(action: ActionContext, contractId: string, input: CreateAmendmentRequest): Promise<AmendmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const id = await this.db.$transaction(async (tx) => {
      const contract = await this.loadManaged(tx, action, organizationId, contractId);
      if (!AMENDABLE.some((status) => status === contract.row.status)) {
        throw new InvalidTransitionError(`A ${contract.row.status} contract cannot be amended.`);
      }
      await this.validate(tx, organizationId, contract, {
        type: input.type,
        valueDelta: input.valueDelta ?? null,
        newExpiryDate: input.newExpiryDate ?? null,
        documentVersionId: input.documentVersionId ?? null,
      });
      const seq = await tx.contract.update({
        where: { id: contractId, organizationId },
        data: { amendmentSeq: { increment: 1 } },
        select: { amendmentSeq: true },
      });
      const created = await tx.contractAmendment.create({
        data: {
          organizationId,
          contractId,
          number: seq.amendmentSeq,
          type: input.type,
          title: input.title,
          description: input.description ?? null,
          effectiveDate: day(input.effectiveDate),
          valueDelta: input.valueDelta == null ? null : decimal(input.valueDelta),
          currency: input.valueDelta == null ? null : contract.row.currency,
          newExpiryDate: input.newExpiryDate == null ? null : day(input.newExpiryDate),
          scopeChangeSummary: input.scopeChangeSummary ?? null,
          documentVersionId: input.documentVersionId ?? null,
          createdByMemberId: action.principal.memberId,
        },
        select: { id: true },
      });
      await appendContractEvent(
        tx,
        organizationId,
        contractId,
        'contract.amendment_created',
        action.principal.memberId,
        {
          amendmentId: created.id,
          key: amendmentKey(contract.row.year, contract.row.number, seq.amendmentSeq),
          type: input.type,
        },
      );
      await recordAudit(tx, organizationId, {
        action: 'contract.amendment_created',
        entityType: 'contract_amendment',
        entityId: created.id,
        actor: userActor(action),
        metadata: { contractId, number: seq.amendmentSeq, type: input.type, hasValueChange: input.valueDelta != null },
        context: action.request,
      });
      return created.id;
    });
    return this.get(action, contractId, id);
  }

  async update(
    action: ActionContext,
    contractId: string,
    amendmentId: string,
    input: UpdateAmendmentRequest,
  ): Promise<AmendmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await this.loadManaged(tx, action, organizationId, contractId);
      const current = await tx.contractAmendment.findFirst({
        where: { organizationId, contractId, id: amendmentId },
        select: amendmentSelect,
      });
      if (current === null) throw new NotFoundError('Amendment');
      if (current.status !== 'DRAFT') throw new InvalidTransitionError('Only a draft amendment can be edited.');
      if (input.valueDelta !== undefined && !canViewContractFinancial(contract)) {
        throw new ForbiddenError('Value changes need the contract financial permission.');
      }
      await this.validate(tx, organizationId, contract, {
        type: input.type ?? current.type,
        valueDelta: input.valueDelta !== undefined ? input.valueDelta : (current.valueDelta?.toString() ?? null),
        newExpiryDate: input.newExpiryDate !== undefined ? input.newExpiryDate : dateOnly(current.newExpiryDate),
        // Only a newly referenced version is checked: the current one may be hidden from this editor.
        documentVersionId: input.documentVersionId ?? null,
        financialChecked: input.valueDelta === undefined,
      });
      const data: Prisma.ContractAmendmentUncheckedUpdateManyInput = { version: { increment: 1 } };
      if (input.type !== undefined) data.type = input.type;
      if (input.title !== undefined) data.title = input.title;
      if (input.description !== undefined) data.description = input.description;
      if (input.effectiveDate !== undefined) data.effectiveDate = day(input.effectiveDate);
      if (input.valueDelta !== undefined) {
        data.valueDelta = input.valueDelta === null ? null : decimal(input.valueDelta);
        data.currency = input.valueDelta === null ? null : contract.row.currency;
      }
      if (input.newExpiryDate !== undefined)
        data.newExpiryDate = input.newExpiryDate === null ? null : day(input.newExpiryDate);
      if (input.scopeChangeSummary !== undefined) data.scopeChangeSummary = input.scopeChangeSummary;
      if (input.documentVersionId !== undefined) data.documentVersionId = input.documentVersionId;
      const result = await tx.contractAmendment.updateMany({
        where: { organizationId, contractId, id: amendmentId, status: 'DRAFT', version: input.version },
        data,
      });
      if (result.count === 0) throw new VersionConflictError('Amendment');
      await recordAudit(tx, organizationId, {
        action: 'contract.amendment_updated',
        entityType: 'contract_amendment',
        entityId: amendmentId,
        actor: userActor(action),
        metadata: { contractId, fields: Object.keys(input).filter((key) => key !== 'version') },
        context: action.request,
      });
    });
    return this.get(action, contractId, amendmentId);
  }

  async act(
    action: ActionContext,
    contractId: string,
    amendmentId: string,
    input: AmendmentActionRequest,
  ): Promise<AmendmentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const contract = await loadVisibleContract(tx, action, organizationId, contractId);
      if (contract.level !== 'FULL') throw new NotFoundError('Amendment');
      await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
      const current = await tx.contractAmendment.findFirst({
        where: { organizationId, contractId, id: amendmentId },
        select: amendmentSelect,
      });
      if (current === null) throw new NotFoundError('Amendment');
      const me = action.principal.memberId;
      const now = this.clock();
      const key = amendmentKey(contract.row.year, contract.row.number, current.number);
      let from: ContractAmendmentStatus;
      let to: ContractAmendmentStatus;
      const data: Prisma.ContractAmendmentUncheckedUpdateManyInput = { version: { increment: 1 } };
      switch (input.action) {
        case 'SUBMIT':
          assertCan(contract, 'contract.manage_amendments');
          [from, to] = ['DRAFT', 'UNDER_REVIEW'];
          data.submittedAt = now;
          break;
        case 'APPROVE':
          assertCan(contract, 'contract.approve');
          if (current.createdByMemberId === me)
            throw new ForbiddenError('An amendment is approved by someone other than its author.');
          [from, to] = ['UNDER_REVIEW', 'APPROVED'];
          data.approvedAt = now;
          data.approvedByMemberId = me;
          break;
        case 'REJECT':
          assertCan(contract, 'contract.approve');
          if (input.reason === undefined) throw new InvalidInputError('reason', 'A rejection needs its reason.');
          [from, to] = ['UNDER_REVIEW', 'REJECTED'];
          data.rejectionReason = input.reason;
          break;
        case 'ACTIVATE':
          assertCan(contract, 'contract.manage_amendments');
          [from, to] = ['APPROVED', 'EFFECTIVE'];
          data.activatedAt = now;
          data.activatedByMemberId = me;
          break;
        case 'CANCEL':
          assertCan(contract, 'contract.manage_amendments');
          if (current.status !== 'DRAFT' && current.status !== 'UNDER_REVIEW' && current.status !== 'APPROVED') {
            throw new InvalidTransitionError(`A ${current.status} amendment cannot be cancelled.`);
          }
          [from, to] = [current.status, 'CANCELLED'];
          break;
      }
      if (current.status !== from) throw new InvalidTransitionError(`The amendment is ${current.status}, not ${from}.`);
      const result = await tx.contractAmendment.updateMany({
        where: { organizationId, contractId, id: amendmentId, status: from, version: input.version },
        data: { ...data, status: to },
      });
      if (result.count === 0) throw new VersionConflictError('Amendment');
      const { today } = await organizationToday(tx, organizationId, now);
      if (to === 'EFFECTIVE') {
        const head = await tx.contract.findFirstOrThrow({
          where: { organizationId, id: contractId },
          select: { version: true, status: true },
        });
        const bumped = await tx.contract.updateMany({
          where: { organizationId, id: contractId, version: head.version },
          data: { version: { increment: 1 } },
        });
        if (bumped.count === 0) throw new VersionConflictError('Contract');
        const refresh: ContractRefresh = await refreshContract(tx, organizationId, contractId, today);
        if (head.status === 'EXPIRED' && refresh.currentExpiryDate !== null && refresh.currentExpiryDate >= today) {
          await tx.contract.updateMany({
            where: { organizationId, id: contractId, status: 'EXPIRED' },
            data: { status: 'ACTIVE' },
          });
          await appendContractEvent(tx, organizationId, contractId, 'contract.status_changed', me, {
            from: 'EXPIRED',
            to: 'ACTIVE',
          });
          // Health depends on the status; the value and expiry changes below are those of the first refresh.
          await refreshContract(tx, organizationId, contractId, today);
        }
        await appendContractEvent(tx, organizationId, contractId, 'contract.amendment_effective', me, {
          amendmentId,
          key,
        });
        if (refresh.previousValue !== refresh.currentValue) {
          await appendContractEvent(
            tx,
            organizationId,
            contractId,
            'contract.value_changed',
            me,
            { amendmentId },
            {
              previousValue: refresh.previousValue,
              currentValue: refresh.currentValue,
            },
          );
        }
        if (refresh.previousExpiryDate !== refresh.currentExpiryDate) {
          await appendContractEvent(tx, organizationId, contractId, 'contract.expiry_changed', me, {
            amendmentId,
            previousExpiryDate: refresh.previousExpiryDate,
            currentExpiryDate: refresh.currentExpiryDate,
          });
        }
      } else {
        await refreshContract(tx, organizationId, contractId, today);
        await appendContractEvent(tx, organizationId, contractId, `contract.amendment_${to.toLowerCase()}`, me, {
          amendmentId,
          key,
        });
      }
      await recordAudit(tx, organizationId, {
        action: `contract.amendment_${input.action.toLowerCase()}`,
        entityType: 'contract_amendment',
        entityId: amendmentId,
        actor: userActor(action),
        metadata: { contractId, from, to },
        context: action.request,
      });
      if (to === 'UNDER_REVIEW') await this.notifyApprovers(tx, organizationId, contract, amendmentId, key, me);
      if (to === 'APPROVED' || to === 'REJECTED') {
        await notifyMembers(
          tx,
          organizationId,
          [current.createdByMemberId],
          {
            type: to === 'APPROVED' ? 'CONTRACT_AMENDMENT_APPROVED' : 'CONTRACT_AMENDMENT_REJECTED',
            severity: to === 'APPROVED' ? 'INFO' : 'WARNING',
            entityType: 'contract',
            entityId: contractId,
            params: {
              contractKey: contractKey(contract.row.year, contract.row.number),
              contractTitle: contract.row.title,
              amendmentKey: key,
            },
            dedupeKey: `CONTRACT_AMENDMENT_${to}:${amendmentId}`,
          },
          (principal) => canAccessResource(principal, 'contract.view', contract.facts),
          me,
        );
      }
      await announceCommercialChange(tx, organizationId, 'contract', contractId);
    });
    return this.get(action, contractId, amendmentId);
  }

  // ---- internals ----

  private async loadManaged(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    contractId: string,
  ): Promise<LoadedContract> {
    const contract = await loadVisibleContract(tx, action, organizationId, contractId);
    if (contract.level !== 'FULL') throw new ForbiddenError();
    assertCan(contract, 'contract.manage_amendments');
    await lockCommercialAggregate(tx, organizationId, 'contract', contractId);
    return contract;
  }

  private async validate(
    tx: TenantDb,
    organizationId: string,
    contract: LoadedContract,
    values: {
      type: ContractAmendmentType;
      valueDelta: string | null;
      newExpiryDate: string | null;
      documentVersionId: string | null;
      financialChecked?: boolean;
    },
  ): Promise<void> {
    if (values.valueDelta !== null && values.financialChecked !== true && !canViewContractFinancial(contract)) {
      throw new ForbiddenError('Value changes need the contract financial permission.');
    }
    if (values.type === 'VALUE_CHANGE' && values.valueDelta === null) {
      throw new InvalidInputError('valueDelta', 'A value change needs its value delta.');
    }
    if (values.type === 'TIME_EXTENSION' && values.newExpiryDate === null) {
      throw new InvalidInputError('newExpiryDate', 'A time extension needs the new expiry date.');
    }
    if (values.newExpiryDate !== null) {
      const head = await tx.contract.findFirstOrThrow({
        where: { organizationId, id: contract.row.id },
        select: { startDate: true, effectiveDate: true },
      });
      const start = dateOnly(head.startDate) ?? dateOnly(head.effectiveDate);
      if (start !== null && values.newExpiryDate < start) {
        throw new InvalidInputError('newExpiryDate', 'The new expiry cannot precede the contract start.');
      }
    }
    if (values.documentVersionId !== null) {
      const version = await tx.commercialDocumentVersion.findFirst({
        where: {
          organizationId,
          id: values.documentVersionId,
          document: { contractId: contract.row.id, ...visibleDocumentWhere(contract, 'contract.financial.view') },
        },
        select: { id: true },
      });
      if (version === null)
        throw new InvalidInputError('documentVersionId', 'Unknown document version of this contract.');
    }
  }

  private async notifyApprovers(
    tx: TenantDb,
    organizationId: string,
    contract: LoadedContract,
    amendmentId: string,
    key: string,
    actorMemberId: string,
  ): Promise<void> {
    const candidates = await permissionHolderIds(tx, organizationId, 'contract.approve');
    await notifyMembers(
      tx,
      organizationId,
      candidates,
      {
        type: 'CONTRACT_AMENDMENT_APPROVAL_REQUESTED',
        severity: 'INFO',
        entityType: 'contract',
        entityId: contract.row.id,
        params: {
          contractKey: contractKey(contract.row.year, contract.row.number),
          contractTitle: contract.row.title,
          amendmentKey: key,
        },
        dedupeKey: `CONTRACT_AMENDMENT_APPROVAL_REQUESTED:${amendmentId}`,
        email: true,
      },
      (principal) =>
        canAccessResource(principal, 'contract.view', contract.facts) &&
        canAccessResource(principal, 'contract.approve', contract.facts),
      actorMemberId,
    );
  }

  private toView(row: AmendmentRow, contract: LoadedContract, me: string): AmendmentView {
    const financial = canViewContractFinancial(contract);
    const delta = financial ? toMoney(row.valueDelta, row.currency) : undefined;
    const manage = contract.can('contract.manage_amendments');
    const approve = contract.can('contract.approve');
    return {
      id: row.id,
      contractId: row.contractId,
      number: row.number,
      key: amendmentKey(contract.row.year, contract.row.number, row.number),
      type: row.type,
      title: row.title,
      description: row.description,
      effectiveDate: dateOnlyStrict(row.effectiveDate),
      ...(delta === undefined ? {} : { valueDelta: delta }),
      hasValueChange: row.valueDelta !== null,
      newExpiryDate: dateOnly(row.newExpiryDate),
      scopeChangeSummary: row.scopeChangeSummary,
      status: row.status,
      submittedAt: isoOrNull(row.submittedAt),
      approvedAt: isoOrNull(row.approvedAt),
      approvedBy: personOrNull(row.approvedBy),
      rejectionReason: row.rejectionReason,
      activatedAt: isoOrNull(row.activatedAt),
      activatedBy: personOrNull(row.activatedBy),
      documentVersionId: visibleVersionId(contract, 'contract.financial.view', row.documentVersion),
      createdBy: personOrNull(row.createdBy),
      createdAt: iso(row.createdAt),
      version: row.version,
      access: {
        canEdit: row.status === 'DRAFT' && manage,
        canSubmit: row.status === 'DRAFT' && manage,
        canApprove: row.status === 'UNDER_REVIEW' && approve && row.createdByMemberId !== me,
        canActivate: row.status === 'APPROVED' && manage,
        canCancel: (row.status === 'DRAFT' || row.status === 'UNDER_REVIEW' || row.status === 'APPROVED') && manage,
      },
    };
  }
}
