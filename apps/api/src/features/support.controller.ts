import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';

import {
  InvalidInputError,
  SupportConfigService,
  TicketCommentService,
  TicketService,
  TicketWatcherService,
} from '@company-ops/core';
import type {
  BusinessCalendarView,
  EscalationRuleView,
  Page,
  ProjectSupportSummary,
  SlaPolicyView,
  SupportCategoryView,
  SupportComponentView,
  TicketCommentView,
  TicketEventView,
  TicketPersonRef,
  TicketSummaryView,
  TicketView,
  TicketWatcherView,
} from '@company-ops/core';
import {
  addWatcherRequestSchema,
  assigneeQuerySchema,
  assignTicketRequestSchema,
  businessCalendarListResponseSchema,
  businessCalendarResponseSchema,
  commentParamsSchema,
  createCalendarRequestSchema,
  createCategoryRequestSchema,
  createCommentRequestSchema,
  createComponentRequestSchema,
  createEscalationRuleRequestSchema,
  createSlaPolicyRequestSchema,
  createTicketRequestSchema,
  editCommentRequestSchema,
  escalationRuleListResponseSchema,
  escalationRuleResponseSchema,
  idempotencyKeySchema,
  idParamsSchema,
  projectSupportResponseSchema,
  projectSupportTeamResponseSchema,
  setProjectSupportTeamRequestSchema,
  slaPolicyListResponseSchema,
  slaPolicyResponseSchema,
  supportCategoryListResponseSchema,
  supportCategoryResponseSchema,
  supportComponentListResponseSchema,
  supportComponentResponseSchema,
  taxonomyListQuerySchema,
  ticketCommentPageResponseSchema,
  ticketCommentResponseSchema,
  ticketEventPageResponseSchema,
  ticketListQuerySchema,
  ticketPageQuerySchema,
  ticketPageResponseSchema,
  ticketPersonListResponseSchema,
  ticketResponseSchema,
  ticketWatcherListResponseSchema,
  transitionTicketRequestSchema,
  updateCalendarRequestSchema,
  updateCategoryRequestSchema,
  updateComponentRequestSchema,
  updateEscalationRuleRequestSchema,
  updateSlaPolicyRequestSchema,
  updateTicketRequestSchema,
  watcherParamsSchema,
} from '@company-ops/validation';
import type {
  AddWatcherRequest,
  AssigneeQuery,
  AssignTicketRequest,
  CommentParams,
  CreateCalendarRequest,
  CreateCategoryRequest,
  CreateCommentRequest,
  CreateComponentRequest,
  CreateEscalationRuleRequest,
  CreateSlaPolicyRequest,
  CreateTicketRequest,
  EditCommentRequest,
  IdParams,
  SetProjectSupportTeamRequest,
  TaxonomyListQuery,
  TicketListQuery,
  TicketPageQuery,
  TransitionTicketRequest,
  UpdateCalendarRequest,
  UpdateCategoryRequest,
  UpdateComponentRequest,
  UpdateEscalationRuleRequest,
  UpdateSlaPolicyRequest,
  UpdateTicketRequest,
  WatcherParams,
} from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
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
  const parsed = idempotencyKeySchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new InvalidInputError('Idempotency-Key', 'The Idempotency-Key header must be a UUID.');
  }
  return parsed.data;
}

/**
 * Support tickets (Phase 3). Route permissions are coarse (`support.view` is held by every role at
 * least for its own tickets); the services evaluate the ticket's scope (out of scope = 404) and the
 * specific permission of each action (visible but not permitted = 403).
 */
@ApiTags('support')
@Controller({ path: 'support/tickets', version: '1' })
export class SupportTicketsController {
  constructor(
    @Inject(TicketService) private readonly tickets: TicketService,
    @Inject(TicketCommentService) private readonly comments: TicketCommentService,
    @Inject(TicketWatcherService) private readonly watchers: TicketWatcherService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('support.view')
  @ApiResult(ticketPageResponseSchema)
  async list(
    @Query({ schema: ticketListQuerySchema }) query: TicketListQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<TicketSummaryView>> {
    return toPage(await this.tickets.list(await this.actions.create(request), query));
  }

  @Post()
  @RequirePermission('support.create')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Client-generated UUID; retries return the same ticket.',
  })
  @ApiResult(ticketResponseSchema, 201)
  async create(
    @Body({ schema: createTicketRequestSchema }) body: CreateTicketRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketView }> {
    return { data: await this.tickets.create(await this.actions.create(request), body, idempotencyKey(request)) };
  }

  @Get(':id')
  @RequirePermission('support.view')
  @ApiResult(ticketResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketView }> {
    return { data: await this.tickets.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('support.view')
  @ApiResult(ticketResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateTicketRequestSchema }) body: UpdateTicketRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketView }> {
    const { version, ...changes } = body;
    return { data: await this.tickets.update(await this.actions.create(request), params.id, version, changes) };
  }

  @Put(':id/assignment')
  @RequirePermission('support.assign')
  @ApiResult(ticketResponseSchema)
  async assign(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: assignTicketRequestSchema }) body: AssignTicketRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketView }> {
    const { version, ...changes } = body;
    return { data: await this.tickets.assign(await this.actions.create(request), params.id, version, changes) };
  }

  @Get(':id/assignees')
  @RequirePermission('support.assign')
  @ApiResult(ticketPersonListResponseSchema)
  async assignees(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: assigneeQuerySchema }) query: AssigneeQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketPersonRef[] }> {
    return { data: await this.tickets.assignableMembers(await this.actions.create(request), params.id, query) };
  }

  @Post(':id/transitions')
  @RequirePermission('support.view')
  @ApiResult(ticketResponseSchema)
  async transition(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: transitionTicketRequestSchema }) body: TransitionTicketRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketView }> {
    const { version, ...input } = body;
    return { data: await this.tickets.transition(await this.actions.create(request), params.id, version, input) };
  }

  @Get(':id/history')
  @RequirePermission('support.view')
  @ApiResult(ticketEventPageResponseSchema)
  async history(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: ticketPageQuerySchema }) query: TicketPageQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<TicketEventView>> {
    return toPage(await this.tickets.history(await this.actions.create(request), params.id, query));
  }

  // ---- Comments ----

  @Get(':id/comments')
  @RequirePermission('support.view')
  @ApiResult(ticketCommentPageResponseSchema)
  async listComments(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: ticketPageQuerySchema }) query: TicketPageQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<TicketCommentView>> {
    return toPage(await this.comments.list(await this.actions.create(request), params.id, query));
  }

  @Post(':id/comments')
  @RequirePermission('support.view')
  @ApiResult(ticketCommentResponseSchema, 201)
  async addComment(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: createCommentRequestSchema }) body: CreateCommentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketCommentView }> {
    return { data: await this.comments.add(await this.actions.create(request), params.id, body) };
  }

  @Patch(':id/comments/:commentId')
  @RequirePermission('support.view')
  @ApiResult(ticketCommentResponseSchema)
  async editComment(
    @Param({ schema: commentParamsSchema }) params: CommentParams,
    @Body({ schema: editCommentRequestSchema }) body: EditCommentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketCommentView }> {
    return { data: await this.comments.edit(await this.actions.create(request), params.id, params.commentId, body) };
  }

  // ---- Watchers ----

  @Get(':id/watchers')
  @RequirePermission('support.view')
  @ApiResult(ticketWatcherListResponseSchema)
  async listWatchers(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketWatcherView[] }> {
    return { data: await this.watchers.list(await this.actions.create(request), params.id) };
  }

  @Post(':id/watchers')
  @RequirePermission('support.view')
  @ApiResult(ticketWatcherListResponseSchema, 201)
  async addWatcher(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: addWatcherRequestSchema }) body: AddWatcherRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketWatcherView[] }> {
    return { data: await this.watchers.add(await this.actions.create(request), params.id, body.memberId) };
  }

  @Delete(':id/watchers/:memberId')
  @RequirePermission('support.view')
  @ApiResult(ticketWatcherListResponseSchema)
  async removeWatcher(
    @Param({ schema: watcherParamsSchema }) params: WatcherParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketWatcherView[] }> {
    return { data: await this.watchers.remove(await this.actions.create(request), params.id, params.memberId) };
  }
}

/**
 * Support configuration. Active categories and components are readable by everyone who may report
 * a ticket; everything else (and every change) needs `support.config` at ORG scope.
 */
@ApiTags('support-config')
@Controller({ path: 'support', version: '1' })
export class SupportConfigController {
  constructor(
    @Inject(SupportConfigService) private readonly config: SupportConfigService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get('categories')
  @RequirePermission('support.create')
  @ApiResult(supportCategoryListResponseSchema)
  async listCategories(
    @Query({ schema: taxonomyListQuerySchema }) query: TaxonomyListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: SupportCategoryView[] }> {
    return {
      data: await this.config.listCategories(await this.actions.create(request), query.includeInactive ?? false),
    };
  }

  @Post('categories')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(supportCategoryResponseSchema, 201)
  async createCategory(
    @Body({ schema: createCategoryRequestSchema }) body: CreateCategoryRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: SupportCategoryView }> {
    return { data: await this.config.createCategory(await this.actions.create(request), body) };
  }

  @Patch('categories/:id')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(supportCategoryResponseSchema)
  async updateCategory(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateCategoryRequestSchema }) body: UpdateCategoryRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: SupportCategoryView }> {
    return { data: await this.config.updateCategory(await this.actions.create(request), params.id, body) };
  }

  @Get('components')
  @RequirePermission('support.create')
  @ApiResult(supportComponentListResponseSchema)
  async listComponents(
    @Query({ schema: taxonomyListQuerySchema }) query: TaxonomyListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: SupportComponentView[] }> {
    return {
      data: await this.config.listComponents(await this.actions.create(request), {
        projectId: query.projectId,
        includeInactive: query.includeInactive ?? false,
      }),
    };
  }

  @Post('components')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(supportComponentResponseSchema, 201)
  async createComponent(
    @Body({ schema: createComponentRequestSchema }) body: CreateComponentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: SupportComponentView }> {
    return { data: await this.config.createComponent(await this.actions.create(request), body) };
  }

  @Patch('components/:id')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(supportComponentResponseSchema)
  async updateComponent(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateComponentRequestSchema }) body: UpdateComponentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: SupportComponentView }> {
    return { data: await this.config.updateComponent(await this.actions.create(request), params.id, body) };
  }

  @Get('calendars')
  @RequirePermission('support.config')
  @ApiResult(businessCalendarListResponseSchema)
  async listCalendars(@Req() request: HttpRequest): Promise<{ data: BusinessCalendarView[] }> {
    return { data: await this.config.listCalendars(await this.actions.create(request)) };
  }

  @Post('calendars')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(businessCalendarResponseSchema, 201)
  async createCalendar(
    @Body({ schema: createCalendarRequestSchema }) body: CreateCalendarRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: BusinessCalendarView }> {
    return { data: await this.config.createCalendar(await this.actions.create(request), body) };
  }

  @Patch('calendars/:id')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(businessCalendarResponseSchema)
  async updateCalendar(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateCalendarRequestSchema }) body: UpdateCalendarRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: BusinessCalendarView }> {
    return { data: await this.config.updateCalendar(await this.actions.create(request), params.id, body) };
  }

  @Get('sla-policies')
  @RequirePermission('support.config')
  @ApiResult(slaPolicyListResponseSchema)
  async listPolicies(@Req() request: HttpRequest): Promise<{ data: SlaPolicyView[] }> {
    return { data: await this.config.listPolicies(await this.actions.create(request)) };
  }

  @Post('sla-policies')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(slaPolicyResponseSchema, 201)
  async createPolicy(
    @Body({ schema: createSlaPolicyRequestSchema }) body: CreateSlaPolicyRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: SlaPolicyView }> {
    return { data: await this.config.createPolicy(await this.actions.create(request), body) };
  }

  @Patch('sla-policies/:id')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(slaPolicyResponseSchema)
  async updatePolicy(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateSlaPolicyRequestSchema }) body: UpdateSlaPolicyRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: SlaPolicyView }> {
    return { data: await this.config.updatePolicy(await this.actions.create(request), params.id, body) };
  }

  @Get('escalation-rules')
  @RequirePermission('support.config')
  @ApiResult(escalationRuleListResponseSchema)
  async listRules(@Req() request: HttpRequest): Promise<{ data: EscalationRuleView[] }> {
    return { data: await this.config.listRules(await this.actions.create(request)) };
  }

  @Post('escalation-rules')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(escalationRuleResponseSchema, 201)
  async createRule(
    @Body({ schema: createEscalationRuleRequestSchema }) body: CreateEscalationRuleRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: EscalationRuleView }> {
    return { data: await this.config.createRule(await this.actions.create(request), body) };
  }

  @Patch('escalation-rules/:id')
  @RequirePermission('support.config')
  @PrincipalRateLimit('sensitive')
  @ApiResult(escalationRuleResponseSchema)
  async updateRule(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateEscalationRuleRequestSchema }) body: UpdateEscalationRuleRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: EscalationRuleView }> {
    return { data: await this.config.updateRule(await this.actions.create(request), params.id, body) };
  }
}

/** The project's Support tab: open-ticket summary and the project's support team. */
@ApiTags('projects')
@Controller({ path: 'projects', version: '1' })
export class ProjectSupportController {
  constructor(
    @Inject(TicketService) private readonly tickets: TicketService,
    @Inject(SupportConfigService) private readonly config: SupportConfigService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id/support')
  @RequirePermission('project.view')
  @ApiResult(projectSupportResponseSchema)
  async summary(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectSupportSummary }> {
    return { data: await this.tickets.projectSummary(await this.actions.create(request), params.id) };
  }

  @Put(':id/support-team')
  @RequirePermission('project.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(projectSupportTeamResponseSchema)
  async setSupportTeam(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: setProjectSupportTeamRequestSchema }) body: SetProjectSupportTeamRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: { supportTeam: { id: string; name: string } | null; version: number } }> {
    return {
      data: await this.config.setProjectSupportTeam(
        await this.actions.create(request),
        params.id,
        body.version,
        body.teamId,
      ),
    };
  }
}
