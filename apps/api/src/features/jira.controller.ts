import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiHeader, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  DomainError,
  InvalidInputError,
  JiraAdminService,
  JiraConnectionService,
  JiraLinksService,
  JiraOverviewService,
  JiraWebhookIntake,
} from '@company-ops/core';
import type {
  JiraConnectionView,
  JiraDeliveryFailureView,
  JiraIntegrationStatus,
  JiraIssueView,
  JiraMappingView,
  JiraProjectOption,
  JiraProjectOverview,
  JiraRunFailureView,
  JiraRunView,
  JiraSiteOption,
  TicketJiraLinkView,
  TicketJiraPanel,
} from '@company-ops/core';
import { ERROR_CODES } from '@company-ops/shared';
import {
  createJiraIssueRequestSchema,
  createJiraMappingRequestSchema,
  idempotencyKeySchema,
  idParamsSchema,
  jiraConnectionResponseSchema,
  jiraConnectRequestSchema,
  jiraConnectResponseSchema,
  jiraDeliveryFailureListResponseSchema,
  jiraGrantParamsSchema,
  jiraIntegrationStatusResponseSchema,
  jiraIssueTypeListResponseSchema,
  jiraMappingListResponseSchema,
  jiraMappingResponseSchema,
  jiraOAuthCallbackQuerySchema,
  jiraProjectOverviewResponseSchema,
  jiraProjectSearchQuerySchema,
  jiraProjectSearchResponseSchema,
  jiraRunDetailResponseSchema,
  jiraRunListQuerySchema,
  jiraRunPageResponseSchema,
  jiraRunRequestSchema,
  jiraRunResponseSchema,
  jiraSelectSiteRequestSchema,
  jiraSiteListResponseSchema,
  jiraVersionQuerySchema,
  jiraWebhookAckResponseSchema,
  jiraWebhookParamsSchema,
  linkJiraIssueRequestSchema,
  ticketJiraIssueTypesQuerySchema,
  ticketJiraLinkParamsSchema,
  ticketJiraLinkResponseSchema,
  ticketJiraPanelResponseSchema,
  ticketJiraSearchQuerySchema,
  ticketJiraSearchResponseSchema,
  updateJiraMappingRequestSchema,
} from '@company-ops/validation';
import type { SchemaOutput as In } from '@company-ops/validation';

import { API_ENV } from '../config/api-env.js';
import type { ApiEnv } from '../config/api-env.js';
import { PrincipalRateLimit, Public, RequirePermission, SkipCsrf, WebhookRateLimit } from '../auth/decorators.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';
import { ApiNoContent, ApiRedirect, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

interface PageBody<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null };
}

const ADMIN_PAGE = '/admin/integrations/jira';

function header(request: HttpRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Jira connection administration (INTEGRATIONS §1.9.2): connect through Atlassian OAuth 2.0 (3LO),
 * choose the site, project mappings, sync runs and failures. All routes need `integration.manage`
 * at organization scope; tokens never leave the server.
 */
@ApiTags('jira')
@Controller({ path: 'integrations/jira', version: '1' })
export class JiraIntegrationController {
  private readonly logger = new Logger(JiraIntegrationController.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(JiraConnectionService) private readonly connections: JiraConnectionService,
    @Inject(JiraAdminService) private readonly admin: JiraAdminService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('integration.manage')
  @ApiResult(jiraIntegrationStatusResponseSchema)
  async status(@Req() request: HttpRequest): Promise<{ data: JiraIntegrationStatus }> {
    return { data: await this.connections.status(await this.actions.create(request)) };
  }

  /** Starts consent: returns the Atlassian authorize URL (state bound to this member, 10 minutes). */
  @Post('connect')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('sensitive')
  @Header('Cache-Control', 'no-store')
  @ApiResult(jiraConnectResponseSchema)
  async connect(
    @Body({ schema: jiraConnectRequestSchema }) body: In<typeof jiraConnectRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: { authorizeUrl: string } }> {
    return { data: await this.connections.startConnect(await this.actions.create(request), body.connectionId ?? null) };
  }

  /**
   * Atlassian redirects the administrator's browser here. Always answers with a redirect to the
   * admin page: `?jira=connected`, `?jira=select-site&grant=<id>` or `?jira=error&reason=<code>`.
   */
  @Get('callback')
  @RequirePermission('integration.manage')
  @ApiRedirect('Redirect to /admin/integrations/jira with the outcome (never a token)')
  async callback(
    @Query({ schema: jiraOAuthCallbackQuerySchema }) query: In<typeof jiraOAuthCallbackQuerySchema>,
    @Req() request: HttpRequest,
    @Res() response: HttpResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const back = (params: Record<string, string>): void => {
      response.redirect(302, `${this.env.APP_PUBLIC_URL}${ADMIN_PAGE}?${new URLSearchParams(params).toString()}`);
    };
    if (query.error !== undefined || query.code === undefined || query.state === undefined) {
      back({ jira: 'error', reason: query.error === 'access_denied' ? 'consent_denied' : 'invalid_callback' });
      return;
    }
    try {
      const result = await this.connections.completeCallback(await this.actions.create(request), {
        code: query.code,
        state: query.state,
      });
      back(result.kind === 'connected' ? { jira: 'connected' } : { jira: 'select-site', grant: result.grantId });
    } catch (error) {
      if (!(error instanceof DomainError)) {
        throw error;
      }
      const code = error.code;
      this.logger.warn({ code }, 'Jira OAuth callback failed');
      back({ jira: 'error', reason: code.toLowerCase() });
    }
  }

  @Get('grants/:grantId/sites')
  @RequirePermission('integration.manage')
  @ApiResult(jiraSiteListResponseSchema)
  async sites(
    @Param({ schema: jiraGrantParamsSchema }) params: In<typeof jiraGrantParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraSiteOption[] }> {
    return { data: await this.connections.pendingSites(await this.actions.create(request), params.grantId) };
  }

  @Post('grants/:grantId/select')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(jiraConnectionResponseSchema)
  async selectSite(
    @Param({ schema: jiraGrantParamsSchema }) params: In<typeof jiraGrantParamsSchema>,
    @Body({ schema: jiraSelectSiteRequestSchema }) body: In<typeof jiraSelectSiteRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraConnectionView }> {
    return {
      data: await this.connections.selectSite(await this.actions.create(request), params.grantId, body.cloudId),
    };
  }

  /** Disconnects: stops sync, removes webhooks and wipes tokens. Cached issues and links stay as history. */
  @Delete('connections/:id')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(jiraConnectionResponseSchema)
  async disconnect(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: jiraVersionQuerySchema }) query: In<typeof jiraVersionQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraConnectionView }> {
    return { data: await this.connections.disconnect(await this.actions.create(request), params.id, query.version) };
  }

  @Get('projects')
  @PrincipalRateLimit('jira')
  @RequirePermission('integration.manage')
  @ApiResult(jiraProjectSearchResponseSchema)
  async searchProjects(
    @Query({ schema: jiraProjectSearchQuerySchema }) query: In<typeof jiraProjectSearchQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraProjectOption[]; isLast: boolean }> {
    const result = await this.admin.searchJiraProjects(
      await this.actions.create(request),
      query.q ?? '',
      query.startAt ?? 0,
    );
    return { data: result.items, isLast: result.isLast };
  }

  @Get('mappings')
  @RequirePermission('integration.manage')
  @ApiResult(jiraMappingListResponseSchema)
  async mappings(@Req() request: HttpRequest): Promise<{ data: JiraMappingView[] }> {
    return { data: await this.admin.listMappings(await this.actions.create(request)) };
  }

  /** Maps a Jira project to a project and queues its initial import. */
  @Post('mappings')
  @PrincipalRateLimit('jira')
  @RequirePermission('integration.manage')
  @ApiResult(jiraMappingResponseSchema, 201)
  async createMapping(
    @Body({ schema: createJiraMappingRequestSchema }) body: In<typeof createJiraMappingRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraMappingView }> {
    return { data: await this.admin.createMapping(await this.actions.create(request), body) };
  }

  @Patch('mappings/:id')
  @PrincipalRateLimit('jira')
  @RequirePermission('integration.manage')
  @ApiResult(jiraMappingResponseSchema)
  async updateMapping(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Body({ schema: updateJiraMappingRequestSchema }) body: In<typeof updateJiraMappingRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraMappingView }> {
    return { data: await this.admin.updateMapping(await this.actions.create(request), params.id, body) };
  }

  /** Stops syncing the Jira project; cached issues stay (links keep their history). */
  @Delete('mappings/:id')
  @PrincipalRateLimit('jira')
  @RequirePermission('integration.manage')
  @ApiNoContent()
  async removeMapping(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: jiraVersionQuerySchema }) query: In<typeof jiraVersionQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.admin.removeMapping(await this.actions.create(request), params.id, query.version);
  }

  /** Manual reconciliation / deep check / full re-sync. One active run per mapping (409 otherwise). */
  @Post('mappings/:id/runs')
  @PrincipalRateLimit('jira')
  @RequirePermission('integration.manage')
  @ApiResult(jiraRunResponseSchema, 201)
  async requestRun(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Body({ schema: jiraRunRequestSchema }) body: In<typeof jiraRunRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraRunView }> {
    return { data: await this.admin.requestRun(await this.actions.create(request), params.id, body.type) };
  }

  @Get('sync-runs')
  @RequirePermission('integration.manage')
  @ApiResult(jiraRunPageResponseSchema)
  async runs(
    @Query({ schema: jiraRunListQuerySchema }) query: In<typeof jiraRunListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<JiraRunView>> {
    const page = await this.admin.listRuns(await this.actions.create(request), query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  @Get('sync-runs/:id')
  @RequirePermission('integration.manage')
  @ApiResult(jiraRunDetailResponseSchema)
  async run(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: { run: JiraRunView; failures: JiraRunFailureView[] } }> {
    return { data: await this.admin.getRun(await this.actions.create(request), params.id) };
  }

  @Post('sync-runs/:id/cancel')
  @PrincipalRateLimit('jira')
  @RequirePermission('integration.manage')
  @ApiResult(jiraRunResponseSchema)
  async cancel(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraRunView }> {
    return { data: await this.admin.cancelRun(await this.actions.create(request), params.id) };
  }

  /** Retries a failed or cancelled run, resuming from its checkpoint where possible. */
  @Post('sync-runs/:id/retry')
  @PrincipalRateLimit('jira')
  @RequirePermission('integration.manage')
  @ApiResult(jiraRunResponseSchema, 201)
  async retry(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraRunView }> {
    return { data: await this.admin.retryRun(await this.actions.create(request), params.id) };
  }

  @Get('webhook-deliveries/failures')
  @RequirePermission('integration.manage')
  @ApiResult(jiraDeliveryFailureListResponseSchema)
  async failedDeliveries(@Req() request: HttpRequest): Promise<{ data: JiraDeliveryFailureView[] }> {
    return { data: await this.admin.failedDeliveries(await this.actions.create(request)) };
  }
}

/**
 * Jira webhook receiver (INTEGRATIONS §1.9.3). Authenticated by the JWT Jira signs with the app's
 * client secret (no session, so no CSRF); the delivery must name a webhook registered for this
 * connection. Intake only records and queues: the worker re-fetches the issue from Jira, so a
 * forged or stale payload can never write issue data.
 */
@ApiTags('jira')
@Controller({ path: 'webhooks/jira', version: '1' })
export class JiraWebhookController {
  private readonly logger = new Logger(JiraWebhookController.name);

  constructor(@Inject(JiraWebhookIntake) private readonly intake: JiraWebhookIntake | null) {}

  @Post(':connectionId')
  @Public()
  @SkipCsrf()
  @WebhookRateLimit()
  @Header('Cache-Control', 'no-store')
  @ApiResult(jiraWebhookAckResponseSchema, 202)
  @ApiResponse({ status: 200, description: 'Duplicate or irrelevant delivery (acknowledged, nothing queued)' })
  async receive(
    @Param({ schema: jiraWebhookParamsSchema }) params: In<typeof jiraWebhookParamsSchema>,
    @Body() body: unknown,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ data: { outcome: 'queued' | 'duplicate' | 'ignored' } }> {
    if (this.intake === null) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Not found.' });
    }
    const result = await this.intake.receive({
      connectionId: params.connectionId,
      authorization: header(request, 'authorization'),
      identifier: header(request, 'x-atlassian-webhook-identifier'),
      retry: header(request, 'x-atlassian-webhook-retry'),
      body,
    });
    switch (result.status) {
      case 202:
      case 200:
        response.status(result.status);
        return { data: { outcome: result.outcome } };
      case 401:
        this.logger.warn({ connectionId: params.connectionId }, 'Jira webhook rejected: invalid token');
        throw new UnauthorizedException({ code: ERROR_CODES.UNAUTHENTICATED, message: 'Invalid webhook token.' });
      case 403:
        this.logger.warn({ connectionId: params.connectionId }, 'Jira webhook rejected: unknown webhook id');
        throw new ForbiddenException({ code: ERROR_CODES.FORBIDDEN, message: 'Unknown webhook.' });
      case 404:
        throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Not found.' });
      case 400:
        throw new BadRequestException({ code: ERROR_CODES.VALIDATION_FAILED, message: 'Invalid webhook payload.' });
    }
  }
}

/**
 * Development (Jira) panel of a support ticket (INTEGRATIONS §1.9.5). The route permission is the
 * ticket's; the service checks `jira.view` / `jira.link` / `jira.create_issue` on the ticket.
 */
@ApiTags('jira')
@Controller({ path: 'support/tickets', version: '1' })
export class TicketJiraController {
  constructor(
    @Inject(JiraLinksService) private readonly links: JiraLinksService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id/jira')
  @RequirePermission('support.view')
  @ApiResult(ticketJiraPanelResponseSchema)
  async panel(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketJiraPanel }> {
    return { data: await this.links.panel(await this.actions.create(request), params.id) };
  }

  @Get(':id/jira/search')
  @PrincipalRateLimit('jira')
  @RequirePermission('jira.link')
  @ApiResult(ticketJiraSearchResponseSchema)
  async search(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: ticketJiraSearchQuerySchema }) query: In<typeof ticketJiraSearchQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: (JiraIssueView & { linked: boolean })[] }> {
    return { data: await this.links.search(await this.actions.create(request), params.id, query) };
  }

  @Post(':id/jira/links')
  @PrincipalRateLimit('jira')
  @RequirePermission('jira.link')
  @ApiResult(ticketJiraLinkResponseSchema, 201)
  async link(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Body({ schema: linkJiraIssueRequestSchema }) body: In<typeof linkJiraIssueRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketJiraLinkView }> {
    return { data: await this.links.link(await this.actions.create(request), params.id, body) };
  }

  @Delete(':id/jira/links/:linkId')
  @PrincipalRateLimit('jira')
  @RequirePermission('jira.link')
  @ApiNoContent()
  async unlink(
    @Param({ schema: ticketJiraLinkParamsSchema }) params: In<typeof ticketJiraLinkParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.links.unlink(await this.actions.create(request), params.id, params.linkId);
  }

  @Get(':id/jira/issue-types')
  @PrincipalRateLimit('jira')
  @RequirePermission('jira.create_issue')
  @ApiResult(jiraIssueTypeListResponseSchema)
  async issueTypes(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: ticketJiraIssueTypesQuerySchema }) query: In<typeof ticketJiraIssueTypesQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: { id: string; name: string }[] }> {
    return { data: await this.links.issueTypes(await this.actions.create(request), params.id, query.mappingId) };
  }

  /** Creates a Jira issue from the ticket and links it. Never changes the ticket's status. */
  @Post(':id/jira/issues')
  @PrincipalRateLimit('jira')
  @RequirePermission('jira.create_issue')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Client-generated UUID; a retry never creates a second issue.',
  })
  @ApiResult(ticketJiraLinkResponseSchema, 201)
  async createIssue(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Body({ schema: createJiraIssueRequestSchema }) body: In<typeof createJiraIssueRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketJiraLinkView }> {
    const parsed = idempotencyKeySchema.safeParse(header(request, 'idempotency-key'));
    if (!parsed.success) {
      throw new InvalidInputError('Idempotency-Key', 'The Idempotency-Key header must be a UUID.');
    }
    return { data: await this.links.createIssue(await this.actions.create(request), params.id, body, parsed.data) };
  }
}

/** Jira tab of a project: mapped Jira projects, sync health and Phase 4 delivery signals. */
@ApiTags('jira')
@Controller({ path: 'projects', version: '1' })
export class ProjectJiraController {
  constructor(
    @Inject(JiraOverviewService) private readonly overview: JiraOverviewService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id/jira')
  @RequirePermission('jira.view')
  @ApiResult(jiraProjectOverviewResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: JiraProjectOverview }> {
    return { data: await this.overview.projectOverview(await this.actions.create(request), params.id) };
  }
}
