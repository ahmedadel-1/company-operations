import type { Prisma, RequestStatus } from '@company-ops/db';
import { formDataSchema } from '@company-ops/validation';
import type { FormSchema, RequestFormData, WorkflowContent } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { nextCounterValue } from '../../platform/db/sql/counters.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidFieldsError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import type { DomainFieldError } from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { assertPermission, canAccessResource, listScope } from '../authorization/policy.js';
import { localToday } from '../projects/business-date.js';
import { loadProjectForAccess } from '../projects/project-access.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import { loadApproverDirectory } from './approver-directory.js';
import type { NormalizedData } from './engine/conditions.js';
import { validateFormData } from './engine/form.js';
import type { FormIssue, FormValidationResult } from './engine/form.js';
import {
  effectSubmissionIssues,
  fulfillmentOrders,
  planRoute,
  requestDates,
  resolveApprovers,
} from './engine/workflow.js';
import type { OwnerAccess } from '../attachments/attachment.service.js';
import {
  canFulfil,
  canViewRequest,
  eligibleApprovers,
  isRequestAdmin,
  isRequester,
  loadRequestForAccess,
  loadVisibleRequest,
  requestScopeWhere,
} from './request-access.js';
import type { LoadedRequest } from './request-access.js';
import { availableTypes, loadAvailableType, toFormJson } from './request-catalog.js';
import { mustLoadVersion } from './request-config.js';
import { buildRequestView } from './request-detail.js';
import { RequestApproverUnresolvedError, RequestFormOutdatedError } from './request-errors.js';
import { recordRequestEvent } from './request-history.js';
import { announceRequestChange, delegatesOf, notifyRequestRecipients } from './request-notify.js';
import {
  eventSubjectId,
  eventViewSelect,
  requestSummarySelect,
  toCatalogItem,
  toEventView,
  toRequestSummary,
} from './request-views.js';
import type { RequestEventView, RequestSummaryView, RequestTypeCatalogItemView, RequestView } from './request-views.js';
import { activateApprovalStep, revokeEffects } from './request-workflow.js';
import type { WorkflowRun } from './request-workflow.js';

const HOUR_MS = 3_600_000;

export interface RequestListFilter {
  readonly view?: 'mine' | 'all' | undefined;
  readonly status?: readonly RequestStatus[] | undefined;
  readonly requestTypeId?: string | undefined;
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface RequestFormView {
  readonly requestType: RequestTypeCatalogItemView;
  readonly workflowVersionId: string;
  readonly workflowVersionNumber: number;
  readonly form: FormSchema;
  readonly attachments: WorkflowContent['attachments'];
}

export interface CreateRequestInput {
  readonly requestTypeId: string;
  readonly formData: RequestFormData;
  readonly submit?: boolean | undefined;
}

export interface ReassignApprovalInput {
  readonly version: number;
  readonly memberId: string;
  readonly replaceApprovalId?: string | undefined;
  readonly reason: string;
}

export interface Paging {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const issuesToFields = (issues: readonly FormIssue[]): DomainFieldError[] =>
  issues.map((issue) => ({ path: issue.path, code: issue.code }));

const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Blank values are dropped by form normalization, so they do not distinguish two submissions. */
function isBlank(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * Canonical JSON (sorted keys) for comparing an idempotent replay with the stored request, applying
 * the same normalization as submission (trimmed text, blank values dropped, lowercase ids).
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => !isBlank(item))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return JSON.stringify(UUID_VALUE.test(trimmed) ? trimmed.toLowerCase() : trimmed);
  }
  return JSON.stringify(value);
}

/**
 * Requests (ADR-0021): catalog, drafts, submission, cancellation, fulfillment, reassignment and history.
 * Every mutation runs in one tenant transaction, re-checks visibility and permissions, and changes the
 * request row with an optimistic `version` condition, so concurrent changes fail with 409.
 */
export class RequestService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async catalog(action: ActionContext): Promise<RequestTypeCatalogItemView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'request.create');
    const types = await availableTypes(this.db, organizationId, action.principal.memberId);
    return types.map((type) => toCatalogItem(type.row));
  }

  async form(action: ActionContext, requestTypeId: string): Promise<RequestFormView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'request.create');
    const type = await loadAvailableType(this.db, organizationId, action.principal.memberId, requestTypeId);
    if (type === null) {
      throw new NotFoundError('Request type');
    }
    const version = await mustLoadVersion(this.db, organizationId, type.publishedVersionId);
    return {
      requestType: toCatalogItem(type.row),
      workflowVersionId: version.id,
      workflowVersionNumber: version.number,
      form: version.form,
      attachments: version.attachments,
    };
  }

  async list(action: ActionContext, filter: RequestListFilter): Promise<Page<RequestSummaryView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const memberId = action.principal.memberId;
    const size = pageSize(filter.limit);
    const and: Prisma.RequestInstanceWhereInput[] = [];
    if (filter.view === 'all') {
      assertPermission(action.principal, 'request.view');
      and.push(requestScopeWhere(listScope(action.principal, 'request.view'), memberId));
    } else {
      and.push({ requesterMemberId: memberId });
    }
    if (filter.status !== undefined && filter.status.length > 0) {
      and.push({ status: { in: [...filter.status] } });
    }
    if (filter.requestTypeId !== undefined) {
      and.push({ requestTypeId: filter.requestTypeId });
    }
    if (filter.q !== undefined) {
      const match = /^(?:REQ-)?(\d{1,9})$/i.exec(filter.q.trim());
      if (match === null) {
        return { items: [], nextCursor: null };
      }
      and.push({ number: Number(match[1]) });
    }
    if (filter.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(filter.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { lt: key } }, { createdAt: key, id: { lt: id } }] });
    }
    const rows = await this.db.requestInstance.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: requestSummarySelect,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map(toRequestSummary), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, requestId: string): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return await buildRequestView(this.db, action, organizationId, requestId, this.clock());
  }

  async history(action: ActionContext, requestId: string, paging: Paging): Promise<Page<RequestEventView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await loadVisibleRequest(this.db, action, organizationId, requestId, this.clock());
    const size = pageSize(paging.limit);
    const and: Prisma.RequestEventWhereInput[] = [];
    if (paging.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(paging.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { gt: key } }, { createdAt: key, id: { gt: id } }] });
    }
    const rows = await this.db.requestEvent.findMany({
      where: { organizationId, requestId, AND: and },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: size + 1,
      select: eventViewSelect,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    const subjectIds = [...new Set(page.items.flatMap((row) => eventSubjectId(row) ?? []))];
    const subjects =
      subjectIds.length === 0
        ? []
        : await this.db.organizationMember.findMany({
            where: { organizationId, id: { in: subjectIds } },
            select: memberRefSelect,
          });
    const subjectMap = new Map(subjects.map((row) => [row.id, toPersonRef(row)]));
    return { items: page.items.map((row) => toEventView(row, subjectMap)), nextCursor: page.nextCursor };
  }

  async create(action: ActionContext, input: CreateRequestInput, idempotencyKey?: string): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'request.create');
    if (idempotencyKey !== undefined) {
      const replay = await this.replay(action, organizationId, idempotencyKey, input);
      if (replay !== null) {
        return replay;
      }
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const now = this.clock();
        const memberId = action.principal.memberId;
        const type = await loadAvailableType(tx, organizationId, memberId, input.requestTypeId);
        if (type === null) {
          throw new NotFoundError('Request type');
        }
        const version = await mustLoadVersion(tx, organizationId, type.publishedVersionId);
        const result = validateFormData(version.form, input.formData, {
          mode: 'draft',
          today: await this.today(tx, organizationId, now),
        });
        const projectId = await this.assertValid(tx, action, organizationId, version.form, result);
        const number = Number(await nextCounterValue(tx, organizationId, 'REQ'));
        const created = await tx.requestInstance.create({
          data: {
            organizationId,
            number,
            requestTypeId: input.requestTypeId,
            workflowVersionId: version.id,
            requesterMemberId: memberId,
            projectId,
            formData: toFormJson(result.data),
            idempotencyKey: idempotencyKey ?? null,
          },
          select: { id: true, version: true },
        });
        await recordRequestEvent(tx, organizationId, created.id, {
          type: 'CREATED',
          actorMemberId: memberId,
          metadata: { workflowVersionId: version.id },
        });
        if (input.submit === true) {
          return await this.submitInTx(tx, action, organizationId, created.id, created.version, now);
        }
        return await buildRequestView(tx, action, organizationId, created.id, now);
      });
    } catch (error) {
      if (idempotencyKey !== undefined && isUniqueViolation(error)) {
        const replay = await this.replay(action, organizationId, idempotencyKey, input);
        if (replay !== null) {
          return replay;
        }
      }
      throw error;
    }
  }

  /**
   * Creates and submits a request of the reserved attendance correction type inside the caller's
   * transaction (ADR-0022). The attendance module validates the correction first; the request then
   * follows the type's published workflow like any other. Returns the request id.
   */
  async createReservedInTx(
    tx: TenantDb,
    action: ActionContext,
    requestTypeId: string,
    formData: RequestFormData,
  ): Promise<string> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'request.create');
    const now = this.clock();
    const memberId = action.principal.memberId;
    const type = await loadAvailableType(tx, organizationId, memberId, requestTypeId, { reserved: true });
    if (type === null) {
      throw new NotFoundError('Request type');
    }
    const version = await mustLoadVersion(tx, organizationId, type.publishedVersionId);
    const result = validateFormData(version.form, formData, {
      mode: 'draft',
      today: await this.today(tx, organizationId, now),
    });
    const projectId = await this.assertValid(tx, action, organizationId, version.form, result);
    const number = Number(await nextCounterValue(tx, organizationId, 'REQ'));
    const created = await tx.requestInstance.create({
      data: {
        organizationId,
        number,
        requestTypeId,
        workflowVersionId: version.id,
        requesterMemberId: memberId,
        projectId,
        formData: toFormJson(result.data),
      },
      select: { id: true, version: true },
    });
    await recordRequestEvent(tx, organizationId, created.id, {
      type: 'CREATED',
      actorMemberId: memberId,
      metadata: { workflowVersionId: version.id },
    });
    await this.submitInTx(tx, action, organizationId, created.id, created.version, now, true);
    return created.id;
  }

  /**
   * Saves draft values. The draft is re-bound to the type's current published version, so a requester
   * who reopens an old draft continues on the live form (values are validated against it).
   */
  async updateDraft(
    action: ActionContext,
    requestId: string,
    expectedVersion: number,
    formData: RequestFormData,
  ): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const loaded = await loadVisibleRequest(tx, action, organizationId, requestId, now);
      this.assertOwnDraft(action, loaded);
      const type = await loadAvailableType(tx, organizationId, action.principal.memberId, loaded.row.requestTypeId);
      if (type === null) {
        throw new InvalidTransitionError('This request type is no longer available.');
      }
      const version = await mustLoadVersion(tx, organizationId, type.publishedVersionId);
      const result = validateFormData(version.form, formData, {
        mode: 'draft',
        today: await this.today(tx, organizationId, now),
      });
      const projectId = await this.assertValid(tx, action, organizationId, version.form, result);
      const updated = await tx.requestInstance.updateMany({
        where: { organizationId, id: requestId, status: 'DRAFT', version: expectedVersion },
        data: {
          workflowVersionId: version.id,
          formData: toFormJson(result.data),
          projectId,
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Request');
      }
      await recordRequestEvent(tx, organizationId, requestId, {
        type: 'UPDATED',
        actorMemberId: action.principal.memberId,
        ...(version.id === loaded.row.workflowVersionId ? {} : { metadata: { workflowVersionId: version.id } }),
      });
      return await buildRequestView(tx, action, organizationId, requestId, now);
    });
  }

  async submit(action: ActionContext, requestId: string, expectedVersion: number): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return await this.db.$transaction(async (tx) =>
      this.submitInTx(tx, action, organizationId, requestId, expectedVersion, this.clock()),
    );
  }

  async cancel(
    action: ActionContext,
    requestId: string,
    expectedVersion: number,
    reason: string | undefined,
  ): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const memberId = action.principal.memberId;
      const loaded = await loadVisibleRequest(tx, action, organizationId, requestId, now);
      const status = loaded.row.status;
      const requester = isRequester(action, loaded);
      const asRequester = requester && (status === 'DRAFT' || status === 'PENDING_APPROVAL');
      const asAdmin = !asRequester && isRequestAdmin(action.principal);
      if (!asRequester && !asAdmin) {
        if (requester) throw new InvalidTransitionError('This request can no longer be cancelled.');
        throw new ForbiddenError();
      }
      if (asAdmin && !(status === 'PENDING_APPROVAL' || status === 'APPROVED' || status === 'IN_FULFILLMENT')) {
        throw new InvalidTransitionError('This request can no longer be cancelled.');
      }
      if (asAdmin && reason === undefined) {
        throw new InvalidInputError('reason', 'A reason is required when an administrator cancels a request.');
      }
      const updated = await tx.requestInstance.updateMany({
        where: { organizationId, id: requestId, status, version: expectedVersion },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason ?? null, version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Request');
      }
      const pending = await tx.requestApproval.findMany({
        where: { organizationId, requestId, status: 'PENDING' },
        select: { approverMemberId: true },
      });
      await tx.requestApproval.updateMany({
        where: { organizationId, requestId, status: 'PENDING' },
        data: { status: 'SUPERSEDED', decidedAt: now },
      });
      const eventId = await recordRequestEvent(tx, organizationId, requestId, {
        type: 'CANCELLED',
        actorMemberId: memberId,
        metadata: { from: status, ...(reason === undefined ? {} : { note: reason }) },
      });
      const run: WorkflowRun = { db: tx, organizationId, now, actorMemberId: memberId };
      await revokeEffects(run, requestId, eventId);
      if (asAdmin) {
        await recordAudit(tx, organizationId, {
          action: 'request.cancelled_by_admin',
          entityType: 'request',
          entityId: requestId,
          actor: userActor(action),
          metadata: { requestNumber: loaded.row.number, from: status },
          context: action.request,
        });
      }
      if (status !== 'DRAFT') {
        await notifyRequestRecipients(
          tx,
          organizationId,
          requestId,
          [loaded.row.requesterMemberId, ...pending.map((row) => row.approverMemberId)],
          { type: 'REQUEST_CANCELLED', severity: 'INFO', email: false, causeId: eventId },
          memberId,
          now,
        );
        await announceRequestChange(tx, organizationId, requestId, status !== 'PENDING_APPROVAL');
      }
      return await buildRequestView(tx, action, organizationId, requestId, now);
    });
  }

  /**
   * Fulfillment of an approved request (`request.fulfill` on it). Requesters never fulfil their own
   * request (separation of duties).
   */
  async fulfil(
    action: ActionContext,
    requestId: string,
    expectedVersion: number,
    step: 'START' | 'COMPLETE_STEP',
    note: string | undefined,
  ): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const memberId = action.principal.memberId;
      const loaded = await loadVisibleRequest(tx, action, organizationId, requestId, now);
      if (!canFulfil(action.principal, loaded) || isRequester(action, loaded)) {
        throw new ForbiddenError();
      }
      const version = await mustLoadVersion(tx, organizationId, loaded.row.workflowVersionId);
      const orders = fulfillmentOrders(loaded.row.route, version.stepsByOrder);
      const noteMeta = note === undefined ? {} : { note };
      if (step === 'START') {
        const first = orders[0];
        if (loaded.row.status !== 'APPROVED' || first === undefined) {
          throw new InvalidTransitionError('Fulfillment cannot be started for this request.');
        }
        await this.bump(tx, organizationId, requestId, 'APPROVED', expectedVersion, {
          status: 'IN_FULFILLMENT',
          currentStepOrder: first,
        });
        await recordRequestEvent(tx, organizationId, requestId, {
          type: 'FULFILLMENT_STARTED',
          actorMemberId: memberId,
          stepOrder: first,
          metadata: noteMeta,
        });
      } else {
        const current = loaded.row.currentStepOrder;
        if (loaded.row.status !== 'IN_FULFILLMENT' || current === null) {
          throw new InvalidTransitionError('This request is not being fulfilled.');
        }
        const next = orders.find((order) => order > current);
        await this.bump(
          tx,
          organizationId,
          requestId,
          'IN_FULFILLMENT',
          expectedVersion,
          next === undefined
            ? { status: 'COMPLETED', completedAt: now, currentStepOrder: null }
            : { currentStepOrder: next },
        );
        await recordRequestEvent(tx, organizationId, requestId, {
          type: 'FULFILLMENT_STEP_COMPLETED',
          actorMemberId: memberId,
          stepOrder: current,
          metadata: noteMeta,
        });
        if (next === undefined) {
          const eventId = await recordRequestEvent(tx, organizationId, requestId, {
            type: 'COMPLETED',
            actorMemberId: memberId,
          });
          await notifyRequestRecipients(
            tx,
            organizationId,
            requestId,
            [loaded.row.requesterMemberId],
            {
              type: 'REQUEST_COMPLETED',
              severity: 'INFO',
              email: version.notifications.emailRequester,
              causeId: eventId,
            },
            memberId,
            now,
          );
        }
      }
      await announceRequestChange(tx, organizationId, requestId, true);
      return await buildRequestView(tx, action, organizationId, requestId, now);
    });
  }

  /**
   * Administrator reassignment of the active approval step (stalled, unassigned or absent approver).
   * The new approver must be eligible and is never the requester.
   */
  async reassign(action: ActionContext, requestId: string, input: ReassignApprovalInput): Promise<RequestView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const memberId = action.principal.memberId;
      const loaded = await loadVisibleRequest(tx, action, organizationId, requestId, now);
      if (!isRequestAdmin(action.principal)) {
        throw new ForbiddenError();
      }
      const order = loaded.row.currentStepOrder;
      if (loaded.row.status !== 'PENDING_APPROVAL' || order === null) {
        throw new InvalidTransitionError('Only a pending request can be reassigned.');
      }
      if (input.memberId === loaded.row.requesterMemberId) {
        throw new InvalidInputError('memberId', 'The requester cannot approve their own request.');
      }
      if (!(await eligibleApprovers(tx, organizationId, [input.memberId])).has(input.memberId)) {
        throw new InvalidInputError('memberId', 'This member cannot approve requests.');
      }
      await this.bump(tx, organizationId, requestId, 'PENDING_APPROVAL', input.version, {}, order);
      const version = await mustLoadVersion(tx, organizationId, loaded.row.workflowVersionId);
      const step = version.stepsByOrder.get(order);
      if (step === undefined) {
        throw new Error('Active step is missing from its version.');
      }
      // One assignment per member and step, whatever its status (unique key); checked first because a
      // unique violation would abort the transaction.
      const already = await tx.requestApproval.findFirst({
        where: { organizationId, requestId, stepOrder: order, approverMemberId: input.memberId },
        select: { id: true },
      });
      if (already !== null) {
        throw new ConflictError('This member is already assigned to the step.');
      }
      if (input.replaceApprovalId !== undefined) {
        const replaced = await tx.requestApproval.updateMany({
          where: { organizationId, id: input.replaceApprovalId, requestId, stepOrder: order, status: 'PENDING' },
          data: { status: 'SUPERSEDED', decidedAt: now },
        });
        if (replaced.count === 0) {
          throw new InvalidInputError(
            'replaceApprovalId',
            'The assignment to replace is not pending on the active step.',
          );
        }
      }
      const created = await tx.requestApproval.create({
        data: {
          organizationId,
          requestId,
          stepId: step.id,
          stepOrder: order,
          approverMemberId: input.memberId,
          dueAt: step.slaHours === null ? null : new Date(now.getTime() + step.slaHours * HOUR_MS),
        },
        select: { id: true },
      });
      const eventId = await recordRequestEvent(tx, organizationId, requestId, {
        type: 'REASSIGNED',
        actorMemberId: memberId,
        stepOrder: order,
        metadata: { subjectMemberId: input.memberId, approvalId: created.id, note: input.reason },
      });
      await recordAudit(tx, organizationId, {
        action: 'request.approval.reassigned',
        entityType: 'request',
        entityId: requestId,
        actor: userActor(action),
        metadata: {
          requestNumber: loaded.row.number,
          stepOrder: order,
          approverMemberId: input.memberId,
          replacedApprovalId: input.replaceApprovalId ?? null,
        },
        context: action.request,
      });
      const delegates = await delegatesOf(tx, organizationId, [input.memberId], loaded.row.requestTypeId, now);
      await notifyRequestRecipients(
        tx,
        organizationId,
        requestId,
        [input.memberId, ...delegates],
        {
          type: 'REQUEST_APPROVAL_ASSIGNED',
          severity: 'INFO',
          email: version.notifications.emailApprovers,
          causeId: eventId,
        },
        memberId,
        now,
      );
      await announceRequestChange(tx, organizationId, requestId, false);
      return await buildRequestView(tx, action, organizationId, requestId, now);
    });
  }

  /**
   * Attachment access (REQUEST owner): viewers of the request may download; only the requester adds or
   * removes files, while the request is a draft and the pinned version allows attachments (count limit
   * re-checked at submission).
   */
  async attachmentAccess(action: ActionContext, requestId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const now = this.clock();
    const loaded = await loadRequestForAccess(this.db, organizationId, requestId, action.principal.memberId, now);
    if (loaded === null || !canViewRequest(action.principal, loaded)) {
      return { canView: false, canUpload: false, canDelete: false };
    }
    const editable = isRequester(action, loaded) && loaded.row.status === 'DRAFT';
    if (!editable) {
      return { canView: true, canUpload: false, canDelete: false };
    }
    const version = await mustLoadVersion(this.db, organizationId, loaded.row.workflowVersionId);
    const live = await this.db.attachment.count({
      where: {
        organizationId,
        ownerType: 'REQUEST',
        ownerId: requestId,
        status: { in: ['PENDING_UPLOAD', 'AVAILABLE'] },
      },
    });
    return {
      canView: true,
      canUpload: version.attachments.requirement !== 'NONE' && live < version.attachments.maxFiles,
      canDelete: true,
    };
  }

  // ---- internals ----

  private assertOwnDraft(action: ActionContext, loaded: LoadedRequest): void {
    if (!isRequester(action, loaded)) {
      throw new ForbiddenError();
    }
    if (loaded.row.status !== 'DRAFT') {
      throw new InvalidTransitionError('Only drafts can be changed.');
    }
  }

  private async today(db: TenantDb, organizationId: string, now: Date): Promise<string> {
    const organization = await db.organization.findFirstOrThrow({
      where: { id: organizationId },
      select: { timeZone: true },
    });
    return localToday(now, organization.timeZone);
  }

  /**
   * Throws field errors for invalid form values or references; returns the first referenced project.
   * Members must be active in the organization; projects must be visible to the requester and not archived.
   */
  private async assertValid(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    form: FormSchema,
    result: FormValidationResult,
    extra: readonly DomainFieldError[] = [],
  ): Promise<string | null> {
    const fieldErrors: DomainFieldError[] = [...issuesToFields(result.issues), ...extra];
    const memberIds = result.memberIds;
    const activeMembers =
      memberIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await db.organizationMember.findMany({
                where: { organizationId, id: { in: [...memberIds] }, status: 'ACTIVE' },
                select: { id: true },
              })
            ).map((row) => row.id),
          );
    let projectId: string | null = null;
    for (const field of form.fields) {
      const value = result.data[field.key];
      if (typeof value !== 'string') continue;
      if (field.type === 'member' && !activeMembers.has(value)) {
        fieldErrors.push({ path: `formData.${field.key}`, code: 'not_allowed' });
      }
      if (field.type === 'project') {
        const project = await loadProjectForAccess(db, organizationId, value);
        if (
          project === null ||
          !canAccessResource(action.principal, 'project.view', project.facts) ||
          project.row.status === 'ARCHIVED'
        ) {
          fieldErrors.push({ path: `formData.${field.key}`, code: 'not_allowed' });
        } else {
          projectId ??= project.id;
        }
      }
    }
    if (fieldErrors.length > 0) {
      throw new InvalidFieldsError('The request form has invalid values.', fieldErrors);
    }
    return projectId;
  }

  private async attachmentIssues(
    db: TenantDb,
    organizationId: string,
    requestId: string,
    policy: WorkflowContent['attachments'],
  ): Promise<DomainFieldError[]> {
    const count = await db.attachment.count({
      where: { organizationId, ownerType: 'REQUEST', ownerId: requestId, status: 'AVAILABLE' },
    });
    if (policy.requirement === 'NONE') return count > 0 ? [{ path: 'attachments', code: 'not_allowed' }] : [];
    if (policy.requirement === 'REQUIRED' && count === 0) return [{ path: 'attachments', code: 'required' }];
    if (count > policy.maxFiles) return [{ path: 'attachments', code: 'too_large' }];
    return [];
  }

  /** Conditional request update (status, version and optionally the active step); 409 when stale. */
  private async bump(
    db: TenantDb,
    organizationId: string,
    requestId: string,
    status: RequestStatus,
    expectedVersion: number,
    data: Prisma.RequestInstanceUpdateManyMutationInput,
    currentStepOrder?: number,
  ): Promise<void> {
    const updated = await db.requestInstance.updateMany({
      where: {
        organizationId,
        id: requestId,
        status,
        version: expectedVersion,
        ...(currentStepOrder === undefined ? {} : { currentStepOrder }),
      },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new VersionConflictError('Request');
    }
  }

  /**
   * Submission (ADR-0021): validates against the pinned published version, fixes the route, checks every
   * approval step can be resolved (409 otherwise, nothing changes), then activates the first step.
   * Submitting an already-submitted request returns it unchanged (idempotent).
   */
  private async submitInTx(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    requestId: string,
    expectedVersion: number,
    now: Date,
    reserved = false,
  ): Promise<RequestView> {
    const memberId = action.principal.memberId;
    const loaded = await loadVisibleRequest(tx, action, organizationId, requestId, now);
    if (!isRequester(action, loaded)) {
      throw new ForbiddenError();
    }
    if (loaded.row.status !== 'DRAFT') {
      if (loaded.row.status === 'CANCELLED') {
        throw new InvalidTransitionError('A cancelled request cannot be submitted.');
      }
      return await buildRequestView(tx, action, organizationId, requestId, now, loaded);
    }
    assertPermission(action.principal, 'request.create');
    const type = await loadAvailableType(tx, organizationId, memberId, loaded.row.requestTypeId, { reserved });
    if (type === null) {
      throw new InvalidTransitionError('This request type is no longer available.');
    }
    if (type.publishedVersionId !== loaded.row.workflowVersionId) {
      throw new RequestFormOutdatedError();
    }
    const version = await mustLoadVersion(tx, organizationId, type.publishedVersionId);
    const result = validateFormData(version.form, formDataSchema.parse(loaded.row.formData), {
      mode: 'submit',
      today: await this.today(tx, organizationId, now),
    });
    const projectId = await this.assertValid(tx, action, organizationId, version.form, result, [
      ...(await this.attachmentIssues(tx, organizationId, requestId, version.attachments)),
      ...effectSubmissionIssues(version.effects, result.data).map((issue) => ({
        path: `formData.${issue.path}`,
        code: issue.code,
      })),
    ]);
    const data: NormalizedData = result.data;
    const route = planRoute(version.steps, data);
    const routeSteps = version.steps.filter((step) => route.includes(step.order));
    const approvalOrders = routeSteps.filter((step) => step.kind === 'APPROVAL').map((step) => step.order);
    const first = approvalOrders[0];
    if (first === undefined) {
      throw new Error('A published workflow always starts with an approval step.');
    }
    const directory = await loadApproverDirectory(tx, organizationId, memberId, routeSteps, data);
    const unresolved = routeSteps
      .filter((step) => step.kind === 'APPROVAL' && !resolveApprovers(step, data, directory).ok)
      .map((step) => step.order);
    if (unresolved.length > 0) {
      throw new RequestApproverUnresolvedError(unresolved);
    }
    const dates = requestDates(version.form, version.effects, data);
    const updated = await tx.requestInstance.updateMany({
      where: { organizationId, id: requestId, status: 'DRAFT', version: expectedVersion },
      data: {
        status: 'PENDING_APPROVAL',
        formData: toFormJson(data),
        route,
        currentStepOrder: first,
        submittedAt: now,
        projectId,
        startsOn: dates === null ? null : new Date(`${dates.startsOn}T00:00:00.000Z`),
        endsOn: dates === null ? null : new Date(`${dates.endsOn}T00:00:00.000Z`),
        version: { increment: 1 },
      },
    });
    if (updated.count === 0) {
      throw new VersionConflictError('Request');
    }
    await recordRequestEvent(tx, organizationId, requestId, {
      type: 'SUBMITTED',
      actorMemberId: memberId,
      metadata: { workflowVersionId: version.id },
    });
    for (const step of version.steps) {
      if (!route.includes(step.order)) {
        await recordRequestEvent(tx, organizationId, requestId, {
          type: 'STEP_SKIPPED',
          actorMemberId: null,
          stepOrder: step.order,
        });
      }
    }
    const run: WorkflowRun = { db: tx, organizationId, now, actorMemberId: memberId };
    await activateApprovalStep(
      run,
      { id: requestId, requesterMemberId: memberId, requestTypeId: loaded.row.requestTypeId },
      version,
      first,
      data,
      directory,
    );
    await announceRequestChange(tx, organizationId, requestId, false);
    return await buildRequestView(tx, action, organizationId, requestId, now);
  }

  private async replay(
    action: ActionContext,
    organizationId: string,
    idempotencyKey: string,
    input: CreateRequestInput,
  ): Promise<RequestView | null> {
    const existing = await this.db.requestInstance.findFirst({
      where: { organizationId, requesterMemberId: action.principal.memberId, idempotencyKey },
      select: { id: true, requestTypeId: true, formData: true, status: true },
    });
    if (existing === null) {
      return null;
    }
    const sameType = existing.requestTypeId === input.requestTypeId;
    const sameData = canonical(existing.formData) === canonical(input.formData);
    if (!sameType || !sameData) {
      throw new ConflictError('The Idempotency-Key was already used for a different request.');
    }
    const now = this.clock();
    const loaded = await loadRequestForAccess(this.db, organizationId, existing.id, action.principal.memberId, now);
    if (loaded === null) {
      return null;
    }
    return await buildRequestView(this.db, action, organizationId, existing.id, now, loaded);
  }
}
