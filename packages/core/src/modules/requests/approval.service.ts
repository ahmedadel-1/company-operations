import type { Prisma } from '@company-ops/db';
import type { LocalizedText } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { assertPermission } from '../authorization/policy.js';
import { toDateOnly } from '../projects/business-date.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import { loadApproverDirectory } from './approver-directory.js';
import { progressAfterApproval, stepOutcome } from './engine/workflow.js';
import { activeDelegationsTo, eligibleApprovers, loadVisibleRequest, requestKey } from './request-access.js';
import { mustLoadVersion, parseLabel, storedFormData } from './request-config.js';
import { buildRequestView } from './request-detail.js';
import { RequestAlreadyDecidedError } from './request-errors.js';
import { recordRequestEvent } from './request-history.js';
import { announceRequestChange, notifyRequestRecipients } from './request-notify.js';
import { requestTypeRefSelect, toTypeRef } from './request-views.js';
import type { PersonRef, RequestTypeRefView, RequestView } from './request-views.js';
import { activateApprovalStep, onRequestApproved } from './request-workflow.js';
import type { WorkflowRun } from './request-workflow.js';

export interface ApprovalInboxItemView {
  readonly approvalId: string;
  readonly request: {
    readonly id: string;
    readonly key: string;
    readonly status: 'PENDING_APPROVAL';
    readonly requestType: RequestTypeRefView;
    readonly requester: PersonRef;
    readonly startsOn: string | null;
    readonly endsOn: string | null;
    readonly submittedAt: string | null;
  };
  readonly step: { readonly order: number; readonly name: LocalizedText; readonly mode: 'ANY_ONE' | 'ALL' };
  readonly onBehalfOf: PersonRef | null;
  readonly dueAt: string | null;
  readonly overdue: boolean;
  readonly assignedAt: string;
}

export interface ApprovalInboxFilter {
  readonly requestTypeId?: string | undefined;
  /** Only assignments whose due time has passed. */
  readonly overdue?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * Pending assignments on active steps of pending requests, assigned to the caller or to members who
 * delegated to them now (respecting the delegation's type restriction), never the caller's own requests.
 * Shared by the inbox, the navigation badge and the dashboard counts (ADR-0023).
 */
export async function approvalInboxWhere(
  db: TenantDb,
  organizationId: string,
  memberId: string,
  now: Date,
  filter: Pick<ApprovalInboxFilter, 'requestTypeId' | 'overdue'>,
): Promise<Prisma.RequestApprovalWhereInput> {
  const delegations = await activeDelegationsTo(db, organizationId, memberId, now);
  const or: Prisma.RequestApprovalWhereInput[] = [
    { approverMemberId: memberId },
    ...delegations.map((delegation) => ({
      approverMemberId: delegation.delegatorMemberId,
      ...(delegation.requestTypeId === null ? {} : { request: { is: { requestTypeId: delegation.requestTypeId } } }),
    })),
  ];
  return {
    status: 'PENDING',
    OR: or,
    ...(filter.overdue === true ? { dueAt: { lt: now } } : {}),
    ...(filter.overdue === false ? { AND: [{ OR: [{ dueAt: null }, { dueAt: { gte: now } }] }] } : {}),
    request: {
      is: {
        status: 'PENDING_APPROVAL',
        requesterMemberId: { not: memberId },
        ...(filter.requestTypeId === undefined ? {} : { requestTypeId: filter.requestTypeId }),
      },
    },
  };
}

const inboxSelect = {
  id: true,
  stepOrder: true,
  dueAt: true,
  createdAt: true,
  approverMemberId: true,
  approver: { select: memberRefSelect },
  step: { select: { name: true, mode: true } },
  request: {
    select: {
      id: true,
      number: true,
      startsOn: true,
      endsOn: true,
      submittedAt: true,
      requestType: { select: requestTypeRefSelect },
      requester: { select: memberRefSelect },
    },
  },
} satisfies Prisma.RequestApprovalSelect;

/**
 * Approvals (ADR-0021): the "needs my approval" inbox and decisions. A decision first takes the request
 * row lock with a conditional update (status and active step unchanged), then flips the assignment with
 * a conditional update (still PENDING), so concurrent or replayed decisions are serialized and only one
 * can win; the step outcome is evaluated after the lock.
 */
export class ApprovalService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async inbox(action: ActionContext, filter: ApprovalInboxFilter): Promise<Page<ApprovalInboxItemView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'request.approve');
    const now = this.clock();
    const size = pageSize(filter.limit);
    const where = await approvalInboxWhere(this.db, organizationId, action.principal.memberId, now, filter);
    const and: Prisma.RequestApprovalWhereInput[] = [where];
    if (filter.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(filter.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { gt: key } }, { createdAt: key, id: { gt: id } }] });
    }
    const rows = await this.db.requestApproval.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: size + 1,
      select: inboxSelect,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return {
      items: page.items.map((row) => ({
        approvalId: row.id,
        request: {
          id: row.request.id,
          key: requestKey(row.request.number),
          status: 'PENDING_APPROVAL',
          requestType: toTypeRef(row.request.requestType),
          requester: toPersonRef(row.request.requester),
          startsOn: toDateOnly(row.request.startsOn),
          endsOn: toDateOnly(row.request.endsOn),
          submittedAt: row.request.submittedAt?.toISOString() ?? null,
        },
        step: { order: row.stepOrder, name: parseLabel(row.step.name), mode: row.step.mode },
        onBehalfOf: row.approverMemberId === action.principal.memberId ? null : toPersonRef(row.approver),
        dueAt: row.dueAt?.toISOString() ?? null,
        overdue: row.dueAt !== null && row.dueAt.getTime() < now.getTime(),
        assignedAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Count for the navigation badge (same filter as the inbox; zero without `request.approve`). */
  async summary(action: ActionContext): Promise<{ pending: number }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!hasPermission(action.principal.permissions, 'request.approve')) {
      return { pending: 0 };
    }
    const where = await approvalInboxWhere(this.db, organizationId, action.principal.memberId, this.clock(), {});
    return { pending: await this.db.requestApproval.count({ where: { organizationId, AND: [where] } }) };
  }

  async approve(action: ActionContext, approvalId: string, comment: string | undefined): Promise<RequestView> {
    return await this.decide(action, approvalId, 'APPROVED', comment);
  }

  async reject(action: ActionContext, approvalId: string, comment: string): Promise<RequestView> {
    return await this.decide(action, approvalId, 'REJECTED', comment);
  }

  private async decide(
    action: ActionContext,
    approvalId: string,
    decision: 'APPROVED' | 'REJECTED',
    comment: string | undefined,
  ): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const memberId = action.principal.memberId;
      const approval = await tx.requestApproval.findFirst({
        where: { organizationId, id: approvalId },
        select: {
          id: true,
          requestId: true,
          stepOrder: true,
          status: true,
          approverMemberId: true,
          decidedByMemberId: true,
        },
      });
      if (approval === null) {
        throw new NotFoundError('Approval');
      }
      const loaded = await loadVisibleRequest(tx, action, organizationId, approval.requestId, now);
      if (approval.status !== 'PENDING') {
        if (approval.status === decision && approval.decidedByMemberId === memberId) {
          return await buildRequestView(tx, action, organizationId, approval.requestId, now, loaded);
        }
        throw new RequestAlreadyDecidedError();
      }
      const decidable = loaded.involvement.decidable.find((item) => item.approvalId === approvalId);
      if (decidable === undefined) {
        throw new ForbiddenError('You cannot decide this approval.');
      }
      assertPermission(action.principal, 'request.approve');
      if (!(await eligibleApprovers(tx, organizationId, [memberId])).has(memberId)) {
        throw new ForbiddenError('You cannot decide this approval.');
      }
      const locked = await tx.requestInstance.updateMany({
        where: {
          organizationId,
          id: approval.requestId,
          status: 'PENDING_APPROVAL',
          currentStepOrder: approval.stepOrder,
        },
        data: { version: { increment: 1 } },
      });
      if (locked.count === 0) {
        throw new RequestAlreadyDecidedError();
      }
      const decided = await tx.requestApproval.updateMany({
        where: { organizationId, id: approvalId, status: 'PENDING' },
        data: {
          status: decision,
          decidedByMemberId: memberId,
          delegationId: decidable.delegationId,
          comment: comment ?? null,
          decidedAt: now,
        },
      });
      if (decided.count === 0) {
        throw new RequestAlreadyDecidedError();
      }
      const delegated = decidable.delegationId !== null;
      const eventId = await recordRequestEvent(tx, organizationId, approval.requestId, {
        type: decision,
        actorMemberId: memberId,
        stepOrder: approval.stepOrder,
        metadata: {
          approvalId,
          ...(comment === undefined ? {} : { note: comment }),
          ...(decidable.delegationId === null
            ? {}
            : { subjectMemberId: approval.approverMemberId, delegationId: decidable.delegationId }),
        },
      });
      await recordAudit(tx, organizationId, {
        action: decision === 'APPROVED' ? 'request.approval.approved' : 'request.approval.rejected',
        entityType: 'request',
        entityId: approval.requestId,
        actor: userActor(action),
        metadata: {
          requestNumber: loaded.row.number,
          stepOrder: approval.stepOrder,
          approvalId,
          onBehalfOfMemberId: delegated ? approval.approverMemberId : null,
          delegationId: decidable.delegationId,
        },
        context: action.request,
      });

      const version = await mustLoadVersion(tx, organizationId, loaded.row.workflowVersionId);
      const step = version.stepsByOrder.get(approval.stepOrder);
      if (step === undefined) {
        throw new Error('Active step is missing from its version.');
      }
      const assignments = await tx.requestApproval.findMany({
        where: { organizationId, requestId: approval.requestId, stepOrder: approval.stepOrder },
        select: { id: true, status: true },
      });
      const outcome = stepOutcome(step.mode, assignments);
      if (outcome.kind !== 'OPEN' && outcome.supersede.length > 0) {
        await tx.requestApproval.updateMany({
          where: { organizationId, id: { in: [...outcome.supersede] }, status: 'PENDING' },
          data: { status: 'SUPERSEDED', decidedAt: now },
        });
      }
      const run: WorkflowRun = { db: tx, organizationId, now, actorMemberId: memberId };
      const ref = {
        id: approval.requestId,
        requesterMemberId: loaded.row.requesterMemberId,
        requestTypeId: loaded.row.requestTypeId,
      };
      let fulfillment = false;
      if (outcome.kind === 'REJECTED') {
        await tx.requestInstance.updateMany({
          where: { organizationId, id: approval.requestId, status: 'PENDING_APPROVAL' },
          data: { status: 'REJECTED', decidedAt: now },
        });
        await notifyRequestRecipients(
          tx,
          organizationId,
          approval.requestId,
          [loaded.row.requesterMemberId],
          {
            type: 'REQUEST_REJECTED',
            severity: 'WARNING',
            email: version.notifications.emailRequester,
            causeId: eventId,
          },
          memberId,
          now,
        );
      } else if (outcome.kind === 'COMPLETED') {
        await recordRequestEvent(tx, organizationId, approval.requestId, {
          type: 'STEP_COMPLETED',
          actorMemberId: null,
          stepOrder: approval.stepOrder,
        });
        const data = storedFormData(loaded.row.formData);
        const progression = progressAfterApproval(loaded.row.route, version.stepsByOrder, approval.stepOrder);
        if (progression.kind === 'ACTIVATE_APPROVAL') {
          const next = version.stepsByOrder.get(progression.order);
          if (next === undefined) {
            throw new Error('Next step is missing from its version.');
          }
          await tx.requestInstance.updateMany({
            where: { organizationId, id: approval.requestId, status: 'PENDING_APPROVAL' },
            data: { currentStepOrder: progression.order },
          });
          const directory = await loadApproverDirectory(tx, organizationId, loaded.row.requesterMemberId, [next], data);
          await activateApprovalStep(run, ref, version, progression.order, data, directory);
        } else {
          fulfillment = progression.fulfillmentOrders.length > 0;
          await tx.requestInstance.updateMany({
            where: { organizationId, id: approval.requestId, status: 'PENDING_APPROVAL' },
            data: { status: 'APPROVED', decidedAt: now, currentStepOrder: null },
          });
          await onRequestApproved(run, ref, version, data, eventId, fulfillment);
        }
      }
      await announceRequestChange(tx, organizationId, approval.requestId, fulfillment);
      return await buildRequestView(tx, action, organizationId, approval.requestId, now);
    });
  }
}
