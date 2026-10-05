import type { Prisma } from '@company-ops/db';
import { FORM_LIMITS } from '@company-ops/validation';
import type { LocalizedText } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockApprovalDelegations } from '../../platform/db/sql/locks.js';
import {
  ConflictError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { assertPermission } from '../authorization/policy.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import { assertRequestAdmin, eligibleApprovers, isRequestAdmin } from './request-access.js';
import { parseLabel } from './request-config.js';
import type { PersonRef } from './request-views.js';

const DAY_MS = 86_400_000;

export type DelegationStatus = 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export interface DelegationView {
  readonly id: string;
  readonly delegator: PersonRef;
  readonly delegate: PersonRef;
  readonly requestType: { readonly id: string; readonly name: LocalizedText } | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason: string | null;
  readonly status: DelegationStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly canRevoke: boolean;
}

export interface CreateDelegationInput {
  readonly delegatorMemberId?: string | undefined;
  readonly delegateMemberId: string;
  readonly requestTypeId?: string | null | undefined;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly reason?: string | undefined;
}

export interface DelegationListFilter {
  readonly view?: 'mine' | 'all' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const delegationSelect = {
  id: true,
  delegatorMemberId: true,
  delegateMemberId: true,
  startsAt: true,
  endsAt: true,
  reason: true,
  revokedAt: true,
  version: true,
  createdAt: true,
  delegator: { select: memberRefSelect },
  delegate: { select: memberRefSelect },
  requestType: { select: { id: true, name: true } },
} satisfies Prisma.ApprovalDelegationSelect;

type DelegationRow = Prisma.ApprovalDelegationGetPayload<{ select: typeof delegationSelect }>;

function statusOf(row: DelegationRow, now: Date): DelegationStatus {
  if (row.revokedAt !== null) return 'REVOKED';
  if (row.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (row.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'ACTIVE';
}

/**
 * Approval delegation (ADR-0021): a member hands their approvals to an eligible delegate for at most
 * 90 days, optionally for one request type. Periods of one delegator never overlap for the same types,
 * reverse delegation in an overlapping period is refused, and delegation is not transitive. Creation
 * and revocation are audited.
 */
export class DelegationService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(action: ActionContext, filter: DelegationListFilter): Promise<Page<DelegationView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const memberId = action.principal.memberId;
    const admin = isRequestAdmin(action.principal);
    if (filter.view === 'all') {
      assertRequestAdmin(action.principal);
    }
    const size = pageSize(filter.limit);
    const and: Prisma.ApprovalDelegationWhereInput[] =
      filter.view === 'all' ? [] : [{ OR: [{ delegatorMemberId: memberId }, { delegateMemberId: memberId }] }];
    if (filter.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(filter.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { lt: key } }, { createdAt: key, id: { lt: id } }] });
    }
    const rows = await this.db.approvalDelegation.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: delegationSelect,
    });
    const now = this.clock();
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map((row) => this.toView(row, memberId, admin, now)), nextCursor: page.nextCursor };
  }

  async create(action: ActionContext, input: CreateDelegationInput): Promise<DelegationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const memberId = action.principal.memberId;
    const delegatorId = input.delegatorMemberId ?? memberId;
    if (delegatorId === memberId) {
      assertPermission(action.principal, 'request.approve');
    } else {
      assertRequestAdmin(action.principal);
    }
    if (input.delegateMemberId === delegatorId) {
      throw new InvalidInputError('delegateMemberId', 'A member cannot delegate to themselves.');
    }
    const now = this.clock();
    const requestedStart = new Date(input.startsAt);
    const startsAt = requestedStart.getTime() < now.getTime() ? now : requestedStart;
    const endsAt = new Date(input.endsAt);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new InvalidInputError('endsAt', 'The delegation must end in the future, after it starts.');
    }
    if (endsAt.getTime() - startsAt.getTime() > FORM_LIMITS.maxDelegationDays * DAY_MS) {
      throw new InvalidInputError(
        'endsAt',
        `A delegation lasts at most ${String(FORM_LIMITS.maxDelegationDays)} days.`,
      );
    }
    const requestTypeId = input.requestTypeId ?? null;
    return await this.db.$transaction(async (tx) => {
      const delegator = await tx.organizationMember.findFirst({
        where: { organizationId, id: delegatorId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (delegator === null) {
        throw new InvalidInputError('delegatorMemberId', 'The delegator is not an active member.');
      }
      if (!(await eligibleApprovers(tx, organizationId, [input.delegateMemberId])).has(input.delegateMemberId)) {
        throw new InvalidInputError('delegateMemberId', 'This member cannot approve requests.');
      }
      if (requestTypeId !== null) {
        const type = await tx.requestType.findFirst({
          where: { organizationId, id: requestTypeId },
          select: { id: true },
        });
        if (type === null) {
          throw new InvalidInputError('requestTypeId', 'Unknown request type.');
        }
      }
      await lockApprovalDelegations(tx, organizationId);
      const overlapping = {
        revokedAt: null,
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      } satisfies Prisma.ApprovalDelegationWhereInput;
      const typeOverlap: Prisma.ApprovalDelegationWhereInput =
        requestTypeId === null ? {} : { OR: [{ requestTypeId: null }, { requestTypeId }] };
      const clash = await tx.approvalDelegation.findFirst({
        where: { organizationId, delegatorMemberId: delegatorId, ...overlapping, ...typeOverlap },
        select: { id: true },
      });
      if (clash !== null) {
        throw new ConflictError('An overlapping delegation already exists for this period.');
      }
      const reverse = await tx.approvalDelegation.findFirst({
        where: {
          organizationId,
          delegatorMemberId: input.delegateMemberId,
          delegateMemberId: delegatorId,
          ...overlapping,
        },
        select: { id: true },
      });
      if (reverse !== null) {
        throw new ConflictError('The delegate already delegates to this member in this period.');
      }
      const created = await tx.approvalDelegation.create({
        data: {
          organizationId,
          delegatorMemberId: delegatorId,
          delegateMemberId: input.delegateMemberId,
          requestTypeId,
          startsAt,
          endsAt,
          reason: input.reason ?? null,
          createdByMemberId: memberId,
        },
        select: delegationSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'request.delegation.created',
        entityType: 'approval_delegation',
        entityId: created.id,
        actor: userActor(action),
        metadata: {
          delegatorMemberId: delegatorId,
          delegateMemberId: input.delegateMemberId,
          requestTypeId,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          onBehalf: delegatorId !== memberId,
        },
        context: action.request,
      });
      await this.notify(tx, organizationId, created, 'REQUEST_DELEGATION_RECEIVED', [input.delegateMemberId], memberId);
      return this.toView(created, memberId, isRequestAdmin(action.principal), now);
    });
  }

  async revoke(action: ActionContext, delegationId: string, expectedVersion: number): Promise<DelegationView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const memberId = action.principal.memberId;
    const admin = isRequestAdmin(action.principal);
    return await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const row = await tx.approvalDelegation.findFirst({
        where: { organizationId, id: delegationId },
        select: delegationSelect,
      });
      const party = row !== null && (row.delegatorMemberId === memberId || row.delegateMemberId === memberId);
      if (row === null || (!party && !admin)) {
        throw new NotFoundError('Delegation');
      }
      const status = statusOf(row, now);
      if (status === 'REVOKED' || status === 'EXPIRED') {
        throw new InvalidTransitionError('This delegation is no longer in effect.');
      }
      const updated = await tx.approvalDelegation.updateMany({
        where: { organizationId, id: delegationId, version: expectedVersion, revokedAt: null },
        data: { revokedAt: now, revokedByMemberId: memberId, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Delegation');
      }
      await recordAudit(tx, organizationId, {
        action: 'request.delegation.revoked',
        entityType: 'approval_delegation',
        entityId: delegationId,
        actor: userActor(action),
        metadata: { delegatorMemberId: row.delegatorMemberId, delegateMemberId: row.delegateMemberId },
        context: action.request,
      });
      await this.notify(
        tx,
        organizationId,
        row,
        'REQUEST_DELEGATION_REVOKED',
        [row.delegatorMemberId, row.delegateMemberId],
        memberId,
      );
      const fresh = await tx.approvalDelegation.findFirstOrThrow({
        where: { organizationId, id: delegationId },
        select: delegationSelect,
      });
      return this.toView(fresh, memberId, admin, now);
    });
  }

  private toView(row: DelegationRow, memberId: string, admin: boolean, now: Date): DelegationView {
    const status = statusOf(row, now);
    return {
      id: row.id,
      delegator: toPersonRef(row.delegator),
      delegate: toPersonRef(row.delegate),
      requestType: row.requestType === null ? null : { id: row.requestType.id, name: parseLabel(row.requestType.name) },
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      reason: row.reason,
      status,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      canRevoke:
        (status === 'ACTIVE' || status === 'SCHEDULED') &&
        (admin || row.delegatorMemberId === memberId || row.delegateMemberId === memberId),
    };
  }

  private async notify(
    db: TenantDb,
    organizationId: string,
    row: DelegationRow,
    type: string,
    recipients: readonly string[],
    actorMemberId: string,
  ): Promise<void> {
    for (const recipient of [...new Set(recipients)].filter((id) => id !== actorMemberId)) {
      await enqueueOutboxEvent(db, organizationId, {
        eventType: 'notification.requested',
        aggregateType: 'approval_delegation',
        aggregateId: row.id,
        payload: {
          recipientMemberId: recipient,
          type,
          severity: 'INFO',
          entityType: 'approval_delegation',
          entityId: row.id,
          params: { delegatorName: toPersonRef(row.delegator).name, delegateName: toPersonRef(row.delegate).name },
          dedupeKey: `${type.toLowerCase()}:${row.id}:${recipient}`,
        },
      });
    }
  }
}
