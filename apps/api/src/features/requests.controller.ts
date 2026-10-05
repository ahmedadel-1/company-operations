import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';

import {
  ApprovalService,
  DelegationService,
  InvalidInputError,
  RequestService,
  RequestTypeAdminService,
} from '@company-ops/core';
import type {
  AdminRequestTypeView,
  ApprovalInboxItemView,
  DelegationView,
  Page,
  RequestEventView,
  RequestFormView,
  RequestSummaryView,
  RequestTypeCatalogItemView,
  RequestView,
  WorkflowVersionSummaryView,
  WorkflowVersionView,
} from '@company-ops/core';
import {
  adminRequestTypeListResponseSchema,
  adminRequestTypeResponseSchema,
  approvalInboxPageResponseSchema,
  approvalInboxQuerySchema,
  approvalParamsSchema,
  approvalSummaryResponseSchema,
  approveSchema,
  cancelRequestSchema,
  createDelegationSchema,
  createRequestSchema,
  createRequestTypeSchema,
  delegationListQuerySchema,
  delegationPageResponseSchema,
  delegationResponseSchema,
  fulfilRequestSchema,
  idParamsSchema,
  reassignApprovalSchema,
  rejectSchema,
  requestEventPageResponseSchema,
  requestEventQuerySchema,
  requestFormResponseSchema,
  requestIdempotencyKeySchema,
  requestListQuerySchema,
  requestPageResponseSchema,
  requestResponseSchema,
  requestTypeCatalogResponseSchema,
  requestVersionSchema,
  updateRequestDraftSchema,
  updateRequestTypeSchema,
  updateWorkflowDraftSchema,
  versionParamsSchema,
  workflowRevisionSchema,
  workflowVersionPageResponseSchema,
  workflowVersionResponseSchema,
} from '@company-ops/validation';
import type {
  ApprovalInboxQuery,
  ApprovalParams,
  ApproveRequest,
  CancelRequestRequest,
  CreateDelegationRequest,
  CreateRequestRequest,
  CreateRequestTypeRequest,
  DelegationListQuery,
  FulfilRequestRequest,
  IdParams,
  ReassignApprovalRequest,
  RejectRequest,
  RequestEventQuery,
  RequestListQuery,
  RequestVersionRequest,
  UpdateRequestDraftRequest,
  UpdateRequestTypeRequest,
  UpdateWorkflowDraftRequest,
  VersionParams,
  WorkflowRevisionRequest,
} from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiNoContent, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

interface PageBody<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null };
}

const toPage = <T>(page: Page<T>): PageBody<T> => ({ data: page.items, page: { nextCursor: page.nextCursor } });

function idempotencyKey(request: HttpRequest): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = requestIdempotencyKeySchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new InvalidInputError('Idempotency-Key', 'The Idempotency-Key header must be a UUID.');
  }
  return parsed.data;
}

/**
 * Request type and workflow administration (Phase 6, ADR-0021). ORG-wide `request.admin` only;
 * published workflow versions are read-only, edits go to the single draft version.
 */
@ApiTags('requests')
@Controller({ path: 'request-admin/types', version: '1' })
export class RequestAdminController {
  constructor(
    @Inject(RequestTypeAdminService) private readonly admin: RequestTypeAdminService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('request.admin')
  @ApiResult(adminRequestTypeListResponseSchema)
  async list(@Req() request: HttpRequest): Promise<{ data: AdminRequestTypeView[] }> {
    return { data: await this.admin.list(await this.actions.create(request)) };
  }

  @Post()
  @RequirePermission('request.admin')
  @ApiResult(adminRequestTypeResponseSchema, 201)
  async create(
    @Body({ schema: createRequestTypeSchema }) body: CreateRequestTypeRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: AdminRequestTypeView }> {
    return { data: await this.admin.create(await this.actions.create(request), body) };
  }

  @Get(':id')
  @RequirePermission('request.admin')
  @ApiResult(adminRequestTypeResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: AdminRequestTypeView }> {
    return { data: await this.admin.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('request.admin')
  @ApiResult(adminRequestTypeResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateRequestTypeSchema }) body: UpdateRequestTypeRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: AdminRequestTypeView }> {
    return { data: await this.admin.update(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/versions')
  @RequirePermission('request.admin')
  @ApiResult(workflowVersionPageResponseSchema)
  async versions(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: requestEventQuerySchema }) query: RequestEventQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<WorkflowVersionSummaryView>> {
    return toPage(await this.admin.listVersions(await this.actions.create(request), params.id, query));
  }

  @Post(':id/versions')
  @RequirePermission('request.admin')
  @ApiResult(workflowVersionResponseSchema, 201)
  async createDraft(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: WorkflowVersionView }> {
    return { data: await this.admin.createDraft(await this.actions.create(request), params.id) };
  }

  @Get(':id/versions/:versionId')
  @RequirePermission('request.admin')
  @ApiResult(workflowVersionResponseSchema)
  async getVersion(
    @Param({ schema: versionParamsSchema }) params: VersionParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: WorkflowVersionView }> {
    return { data: await this.admin.getVersion(await this.actions.create(request), params.id, params.versionId) };
  }

  @Put(':id/versions/:versionId')
  @RequirePermission('request.admin')
  @ApiResult(workflowVersionResponseSchema)
  async updateDraft(
    @Param({ schema: versionParamsSchema }) params: VersionParams,
    @Body({ schema: updateWorkflowDraftSchema }) body: UpdateWorkflowDraftRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: WorkflowVersionView }> {
    const { revision, ...content } = body;
    return {
      data: await this.admin.updateDraft(
        await this.actions.create(request),
        params.id,
        params.versionId,
        content,
        revision,
      ),
    };
  }

  @Post(':id/versions/:versionId/publish')
  @RequirePermission('request.admin')
  @PrincipalRateLimit('sensitive')
  @HttpCode(200)
  @ApiResult(workflowVersionResponseSchema)
  async publish(
    @Param({ schema: versionParamsSchema }) params: VersionParams,
    @Body({ schema: workflowRevisionSchema }) body: WorkflowRevisionRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: WorkflowVersionView }> {
    return {
      data: await this.admin.publish(await this.actions.create(request), params.id, params.versionId, body.revision),
    };
  }

  @Post(':id/versions/:versionId/discard')
  @RequirePermission('request.admin')
  @HttpCode(204)
  @ApiNoContent()
  async discard(
    @Param({ schema: versionParamsSchema }) params: VersionParams,
    @Body({ schema: workflowRevisionSchema }) body: WorkflowRevisionRequest,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.admin.discardDraft(await this.actions.create(request), params.id, params.versionId, body.revision);
  }
}

/** The requester catalog: active types the caller may submit, and the form of the published version. */
@ApiTags('requests')
@Controller({ path: 'request-types', version: '1' })
export class RequestTypesController {
  constructor(
    @Inject(RequestService) private readonly requests: RequestService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('request.create')
  @ApiResult(requestTypeCatalogResponseSchema)
  async catalog(@Req() request: HttpRequest): Promise<{ data: RequestTypeCatalogItemView[] }> {
    return { data: await this.requests.catalog(await this.actions.create(request)) };
  }

  @Get(':id/form')
  @RequirePermission('request.create')
  @ApiResult(requestFormResponseSchema)
  async form(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestFormView }> {
    return { data: await this.requests.form(await this.actions.create(request), params.id) };
  }
}

/**
 * Requests (Phase 6). Route permissions are coarse; the services evaluate visibility (out of scope or
 * someone else's draft = 404) and each action's own rule (visible but not permitted = 403).
 */
@ApiTags('requests')
@Controller({ path: 'requests', version: '1' })
export class RequestsController {
  constructor(
    @Inject(RequestService) private readonly requests: RequestService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('request.view')
  @ApiResult(requestPageResponseSchema)
  async list(
    @Query({ schema: requestListQuerySchema }) query: RequestListQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<RequestSummaryView>> {
    return toPage(await this.requests.list(await this.actions.create(request), query));
  }

  @Post()
  @RequirePermission('request.create')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Client-generated UUID; retries return the same request.',
  })
  @ApiResult(requestResponseSchema, 201)
  async create(
    @Body({ schema: createRequestSchema }) body: CreateRequestRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return { data: await this.requests.create(await this.actions.create(request), body, idempotencyKey(request)) };
  }

  @Get(':id')
  @RequirePermission('request.view')
  @ApiResult(requestResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return { data: await this.requests.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('request.create')
  @ApiResult(requestResponseSchema)
  async updateDraft(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateRequestDraftSchema }) body: UpdateRequestDraftRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return {
      data: await this.requests.updateDraft(await this.actions.create(request), params.id, body.version, body.formData),
    };
  }

  @Post(':id/submit')
  @RequirePermission('request.create')
  @HttpCode(200)
  @ApiResult(requestResponseSchema)
  async submit(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: requestVersionSchema }) body: RequestVersionRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return { data: await this.requests.submit(await this.actions.create(request), params.id, body.version) };
  }

  @Post(':id/cancel')
  @RequirePermission('request.view')
  @HttpCode(200)
  @ApiResult(requestResponseSchema)
  async cancel(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: cancelRequestSchema }) body: CancelRequestRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return {
      data: await this.requests.cancel(await this.actions.create(request), params.id, body.version, body.reason),
    };
  }

  @Post(':id/fulfillment')
  @RequirePermission('request.fulfill')
  @HttpCode(200)
  @ApiResult(requestResponseSchema)
  async fulfil(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: fulfilRequestSchema }) body: FulfilRequestRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return {
      data: await this.requests.fulfil(
        await this.actions.create(request),
        params.id,
        body.version,
        body.action,
        body.note,
      ),
    };
  }

  @Post(':id/reassign')
  @RequirePermission('request.admin')
  @PrincipalRateLimit('sensitive')
  @HttpCode(200)
  @ApiResult(requestResponseSchema)
  async reassign(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: reassignApprovalSchema }) body: ReassignApprovalRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return { data: await this.requests.reassign(await this.actions.create(request), params.id, body) };
  }

  @Get(':id/history')
  @RequirePermission('request.view')
  @ApiResult(requestEventPageResponseSchema)
  async history(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: requestEventQuerySchema }) query: RequestEventQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<RequestEventView>> {
    return toPage(await this.requests.history(await this.actions.create(request), params.id, query));
  }
}

/** "Needs my approval": pending assignments of the caller and of members who delegated to them. */
@ApiTags('requests')
@Controller({ path: 'approvals', version: '1' })
export class ApprovalsController {
  constructor(
    @Inject(ApprovalService) private readonly approvals: ApprovalService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('request.approve')
  @ApiResult(approvalInboxPageResponseSchema)
  async inbox(
    @Query({ schema: approvalInboxQuerySchema }) query: ApprovalInboxQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<ApprovalInboxItemView>> {
    return toPage(await this.approvals.inbox(await this.actions.create(request), query));
  }

  @Get('summary')
  @ApiResult(approvalSummaryResponseSchema)
  async summary(@Req() request: HttpRequest): Promise<{ data: { pending: number } }> {
    return { data: await this.approvals.summary(await this.actions.create(request)) };
  }

  @Post(':approvalId/approve')
  @RequirePermission('request.approve')
  @HttpCode(200)
  @ApiResult(requestResponseSchema)
  async approve(
    @Param({ schema: approvalParamsSchema }) params: ApprovalParams,
    @Body({ schema: approveSchema }) body: ApproveRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return { data: await this.approvals.approve(await this.actions.create(request), params.approvalId, body.comment) };
  }

  @Post(':approvalId/reject')
  @RequirePermission('request.approve')
  @HttpCode(200)
  @ApiResult(requestResponseSchema)
  async reject(
    @Param({ schema: approvalParamsSchema }) params: ApprovalParams,
    @Body({ schema: rejectSchema }) body: RejectRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RequestView }> {
    return { data: await this.approvals.reject(await this.actions.create(request), params.approvalId, body.comment) };
  }
}

/** Approval delegation (out-of-office). */
@ApiTags('requests')
@Controller({ path: 'approval-delegations', version: '1' })
export class ApprovalDelegationsController {
  constructor(
    @Inject(DelegationService) private readonly delegations: DelegationService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('request.approve')
  @ApiResult(delegationPageResponseSchema)
  async list(
    @Query({ schema: delegationListQuerySchema }) query: DelegationListQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<DelegationView>> {
    return toPage(await this.delegations.list(await this.actions.create(request), query));
  }

  @Post()
  @RequirePermission('request.approve')
  @PrincipalRateLimit('sensitive')
  @ApiResult(delegationResponseSchema, 201)
  async create(
    @Body({ schema: createDelegationSchema }) body: CreateDelegationRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: DelegationView }> {
    return { data: await this.delegations.create(await this.actions.create(request), body) };
  }

  @Post(':id/revoke')
  @RequirePermission('request.approve')
  @HttpCode(200)
  @ApiResult(delegationResponseSchema)
  async revoke(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: requestVersionSchema }) body: RequestVersionRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: DelegationView }> {
    return { data: await this.delegations.revoke(await this.actions.create(request), params.id, body.version) };
  }
}
