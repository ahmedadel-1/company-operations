import { createHash } from 'node:crypto';

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  DomainError,
  GithubAdminService,
  GithubProjectService,
  GithubSetupService,
  GithubTicketService,
  GithubWebhookIntake,
  RetentionPolicyService,
} from '@company-ops/core';
import type {
  GithubDeliveryView,
  GithubInstallationView,
  GithubIntegrationStatus,
  GithubJiraIssueOption,
  GithubProjectOverview,
  GithubPullView,
  GithubRepositoryView,
  GithubRunFailureView,
  GithubRunView,
  RetentionPolicyView,
  RetentionPreview,
  TicketGithubPanel,
  TicketPullOption,
} from '@company-ops/core';
import { ERROR_CODES } from '@company-ops/shared';
import {
  createGithubMappingRequestSchema,
  githubCallbackQuerySchema,
  githubDeliveryListQuerySchema,
  githubDeliveryPageResponseSchema,
  githubInstallationResponseSchema,
  githubInstallResponseSchema,
  githubIntegrationStatusResponseSchema,
  githubProjectOverviewResponseSchema,
  githubPullListQuerySchema,
  githubPullPageResponseSchema,
  githubPullResponseSchema,
  githubRepositoryListQuerySchema,
  githubRepositoryListResponseSchema,
  githubRepositoryResponseSchema,
  githubRunDetailResponseSchema,
  githubRunListQuerySchema,
  githubRunPageResponseSchema,
  githubRunResponseSchema,
  githubSetupQuerySchema,
  githubVersionQuerySchema,
  githubWebhookAckResponseSchema,
  idParamsSchema,
  linkPullJiraIssueRequestSchema,
  linkTicketPullRequestSchema,
  projectJiraIssueSearchQuerySchema,
  projectJiraIssueSearchResponseSchema,
  projectPullLinkParamsSchema,
  projectPullParamsSchema,
  retentionCategoryParamsSchema,
  retentionPolicyListResponseSchema,
  retentionPreviewQuerySchema,
  retentionPreviewResponseSchema,
  setRetentionPolicyRequestSchema,
  ticketGithubPanelResponseSchema,
  ticketPullLinkParamsSchema,
  ticketPullSearchQuerySchema,
  ticketPullSearchResponseSchema,
} from '@company-ops/validation';
import type { SchemaOutput as In } from '@company-ops/validation';

import { API_ENV } from '../config/api-env.js';
import type { ApiEnv } from '../config/api-env.js';
import { PrincipalRateLimit, Public, RequirePermission, SkipCsrf, WebhookRateLimit } from '../auth/decorators.js';
import type { GithubRawBodyRequest } from '../http/github-raw-body.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';
import { ApiNoContent, ApiRedirect, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

interface PageBody<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null };
}

type WebhookOutcome = 'queued' | 'duplicate' | 'ignored';

const ADMIN_PAGE = '/admin/integrations/github';

function header(request: HttpRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Binds setup state to the browser session without keeping the session id itself in Redis: a
 * one-way hash of the server-side session id (never sent to GitHub).
 */
function sessionBinding(request: HttpRequest): string {
  const sessionId = request.auth?.sessionId;
  if (sessionId === undefined) {
    throw new UnauthorizedException({ code: ERROR_CODES.UNAUTHENTICATED, message: 'Authentication is required.' });
  }
  return createHash('sha256').update(`github-setup:${sessionId}`).digest('hex');
}

/**
 * GitHub App administration (INTEGRATIONS §2, ADR-0020): installation setup and binding, repository
 * mappings, sync runs and webhook deliveries. Every route needs `integration.manage` at organization
 * scope, which the action context only grants with a satisfied MFA session. No route returns or
 * accepts App JWTs, installation tokens, user tokens, private keys or webhook secrets.
 */
@ApiTags('github')
@Controller({ path: 'integrations/github', version: '1' })
export class GithubIntegrationController {
  private readonly logger = new Logger(GithubIntegrationController.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(GithubSetupService) private readonly setup: GithubSetupService,
    @Inject(GithubAdminService) private readonly admin: GithubAdminService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('integration.manage')
  @ApiResult(githubIntegrationStatusResponseSchema)
  async status(@Req() request: HttpRequest): Promise<{ data: GithubIntegrationStatus }> {
    return { data: await this.admin.status(await this.actions.create(request)) };
  }

  /** Starts installation: returns GitHub's install URL with a single-use, session-bound state (10 minutes). */
  @Post('install')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @Header('Cache-Control', 'no-store')
  @ApiResult(githubInstallResponseSchema)
  async install(@Req() request: HttpRequest): Promise<{ data: { installUrl: string } }> {
    return { data: await this.setup.startInstall(await this.actions.create(request), sessionBinding(request)) };
  }

  /**
   * GitHub's post-installation setup URL. `installation_id` is untrusted: with a valid state the
   * browser continues to GitHub user authorization (proof of access); otherwise only an
   * installation already bound to this organization is refreshed. Always redirects.
   */
  @Get('setup')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @ApiRedirect('Redirect to GitHub user authorization or to /admin/integrations/github with the outcome')
  async setupReturn(
    @Query({ schema: githubSetupQuerySchema }) query: In<typeof githubSetupQuerySchema>,
    @Req() request: HttpRequest,
    @Res() response: HttpResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const step = await this.setup.handleSetup(await this.actions.create(request), sessionBinding(request), {
        installationId: query.installation_id ?? null,
        setupAction: query.setup_action ?? null,
        state: query.state ?? null,
      });
      switch (step.kind) {
        case 'authorize':
          response.redirect(302, step.url);
          return;
        case 'requested':
          this.back(response, { github: 'requested' });
          return;
        case 'refreshed':
          this.back(response, { github: 'refreshed' });
          return;
      }
    } catch (error) {
      this.fail(response, error, 'GitHub setup return failed');
    }
  }

  /** User-authorization callback: proves access to the installation, then binds it. Always redirects. */
  @Get('callback')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @ApiRedirect('Redirect to /admin/integrations/github with the outcome (never a token)')
  async callback(
    @Query({ schema: githubCallbackQuerySchema }) query: In<typeof githubCallbackQuerySchema>,
    @Req() request: HttpRequest,
    @Res() response: HttpResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    if (query.error !== undefined || query.code === undefined || query.state === undefined) {
      this.back(response, {
        github: 'error',
        reason: query.error === 'access_denied' ? 'authorization_denied' : 'invalid_callback',
      });
      return;
    }
    try {
      await this.setup.completeCallback(await this.actions.create(request), sessionBinding(request), {
        code: query.code,
        state: query.state,
      });
      this.back(response, { github: 'installed' });
    } catch (error) {
      this.fail(response, error, 'GitHub setup callback failed');
    }
  }

  @Post('installations/:id/refresh')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @ApiNoContent()
  async refresh(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.admin.refreshInstallation(await this.actions.create(request), params.id);
  }

  /** Unbinds the installation here (sync stops, history stays). The App stays installed on GitHub. */
  @Delete('installations/:id')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(githubInstallationResponseSchema)
  async disconnect(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: githubVersionQuerySchema }) query: In<typeof githubVersionQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubInstallationView }> {
    return { data: await this.admin.disconnect(await this.actions.create(request), params.id, query.version) };
  }

  @Get('repositories')
  @RequirePermission('integration.manage')
  @ApiResult(githubRepositoryListResponseSchema)
  async repositories(
    @Query({ schema: githubRepositoryListQuerySchema }) query: In<typeof githubRepositoryListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubRepositoryView[] }> {
    return { data: await this.admin.listRepositories(await this.actions.create(request), query) };
  }

  /** Maps a repository to a project (many-to-many) and queues its initial sync. */
  @Post('mappings')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @ApiResult(githubRepositoryResponseSchema, 201)
  async createMapping(
    @Body({ schema: createGithubMappingRequestSchema }) body: In<typeof createGithubMappingRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubRepositoryView }> {
    return { data: await this.admin.createMapping(await this.actions.create(request), body) };
  }

  @Delete('mappings/:id')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @ApiNoContent()
  async removeMapping(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: githubVersionQuerySchema }) query: In<typeof githubVersionQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.admin.removeMapping(await this.actions.create(request), params.id, query.version);
  }

  /** Manual full re-sync of a repository. One active run per repository (409 otherwise). */
  @Post('repositories/:id/sync')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @ApiResult(githubRunResponseSchema, 201)
  async sync(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubRunView }> {
    return { data: await this.admin.requestSync(await this.actions.create(request), params.id) };
  }

  @Get('sync-runs')
  @RequirePermission('integration.manage')
  @ApiResult(githubRunPageResponseSchema)
  async runs(
    @Query({ schema: githubRunListQuerySchema }) query: In<typeof githubRunListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<GithubRunView>> {
    const page = await this.admin.listRuns(await this.actions.create(request), query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  @Get('sync-runs/:id')
  @RequirePermission('integration.manage')
  @ApiResult(githubRunDetailResponseSchema)
  async run(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: { run: GithubRunView; failures: GithubRunFailureView[] } }> {
    return { data: await this.admin.getRun(await this.actions.create(request), params.id) };
  }

  @Post('sync-runs/:id/cancel')
  @RequirePermission('integration.manage')
  @PrincipalRateLimit('github')
  @ApiResult(githubRunResponseSchema)
  async cancel(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubRunView }> {
    return { data: await this.admin.cancelRun(await this.actions.create(request), params.id) };
  }

  /** Redacted delivery log: identifiers, event names and outcomes only (never payloads or headers). */
  @Get('webhook-deliveries')
  @RequirePermission('integration.manage')
  @ApiResult(githubDeliveryPageResponseSchema)
  async deliveries(
    @Query({ schema: githubDeliveryListQuerySchema }) query: In<typeof githubDeliveryListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<GithubDeliveryView>> {
    const page = await this.admin.listDeliveries(await this.actions.create(request), query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  private back(response: HttpResponse, params: Record<string, string>): void {
    response.redirect(302, `${this.env.APP_PUBLIC_URL}${ADMIN_PAGE}?${new URLSearchParams(params).toString()}`);
  }

  private fail(response: HttpResponse, error: unknown, message: string): void {
    if (!(error instanceof DomainError)) {
      throw error;
    }
    const code = error.code;
    this.logger.warn({ code }, message);
    this.back(response, { github: 'error', reason: code.toLowerCase() });
  }
}

/**
 * GitHub webhook receiver (INTEGRATIONS §2.6). Authenticated only by the `X-Hub-Signature-256`
 * HMAC over the raw body (no session, so no CSRF); the legacy SHA-1 header is ignored. The tenant
 * comes from the persisted installation binding, never from the payload. Intake records and
 * queues; the worker re-fetches from GitHub, so a payload can never write pull-request data.
 */
@ApiTags('github')
@Controller({ path: 'webhooks/github', version: '1' })
export class GithubWebhookController {
  private readonly logger = new Logger(GithubWebhookController.name);

  constructor(@Inject(GithubWebhookIntake) private readonly intake: GithubWebhookIntake | null) {}

  @Post()
  @Public()
  @SkipCsrf()
  @WebhookRateLimit()
  @Header('Cache-Control', 'no-store')
  @ApiResult(githubWebhookAckResponseSchema, 202)
  @ApiResponse({ status: 200, description: 'Duplicate or irrelevant delivery (acknowledged, nothing queued)' })
  @ApiResponse({ status: 413, description: 'Payload larger than GITHUB_WEBHOOK_MAX_BYTES' })
  async receive(
    @Req() request: HttpRequest & GithubRawBodyRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ data: { outcome: WebhookOutcome } }> {
    if (this.intake === null) {
      throw new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: 'Not found.' });
    }
    const rawBody = request.githubRawBody;
    if (rawBody === undefined) {
      throw new BadRequestException({ code: ERROR_CODES.VALIDATION_FAILED, message: 'Invalid webhook payload.' });
    }
    const result = await this.intake.receive({
      signature: header(request, 'x-hub-signature-256'),
      event: header(request, 'x-github-event'),
      deliveryId: header(request, 'x-github-delivery'),
      targetType: header(request, 'x-github-hook-installation-target-type'),
      rawBody,
    });
    switch (result.status) {
      case 202:
        response.status(202);
        return { data: { outcome: 'queued' } };
      case 200:
        response.status(200);
        return { data: { outcome: result.outcome } };
      case 401:
        this.logger.warn(
          { event: header(request, 'x-github-event') ?? null },
          'GitHub webhook rejected: invalid signature',
        );
        throw new UnauthorizedException({ code: ERROR_CODES.UNAUTHENTICATED, message: 'Invalid webhook signature.' });
      case 400:
        throw new BadRequestException({ code: ERROR_CODES.VALIDATION_FAILED, message: 'Invalid webhook payload.' });
    }
  }
}

/** GitHub tab of a project: mapped repositories, sync health, pull requests and Jira associations. */
@ApiTags('github')
@Controller({ path: 'projects', version: '1' })
export class ProjectGithubController {
  constructor(
    @Inject(GithubProjectService) private readonly github: GithubProjectService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id/github')
  @RequirePermission('github.view')
  @ApiResult(githubProjectOverviewResponseSchema)
  async overview(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubProjectOverview }> {
    return { data: await this.github.overview(await this.actions.create(request), params.id) };
  }

  @Get(':id/github/pulls')
  @RequirePermission('github.view')
  @ApiResult(githubPullPageResponseSchema)
  async pulls(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: githubPullListQuerySchema }) query: In<typeof githubPullListQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<PageBody<GithubPullView>> {
    const page = await this.github.listPulls(await this.actions.create(request), params.id, query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  @Get(':id/github/jira-issues')
  @RequirePermission('github.link')
  @ApiResult(projectJiraIssueSearchResponseSchema)
  async jiraIssues(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: projectJiraIssueSearchQuerySchema }) query: In<typeof projectJiraIssueSearchQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubJiraIssueOption[] }> {
    return { data: await this.github.searchJiraIssues(await this.actions.create(request), params.id, query.q) };
  }

  /** Links a pull request to a cached Jira issue of a Jira project mapped to this project. */
  @Post(':id/github/pulls/:pullId/jira-links')
  @RequirePermission('github.link')
  @ApiResult(githubPullResponseSchema, 201)
  async linkJira(
    @Param({ schema: projectPullParamsSchema }) params: In<typeof projectPullParamsSchema>,
    @Body({ schema: linkPullJiraIssueRequestSchema }) body: In<typeof linkPullJiraIssueRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubPullView }> {
    return {
      data: await this.github.linkJiraIssue(await this.actions.create(request), params.id, params.pullId, body.issueId),
    };
  }

  @Post(':id/github/jira-links/:linkId/confirm')
  @RequirePermission('github.link')
  @ApiResult(githubPullResponseSchema)
  async confirm(
    @Param({ schema: projectPullLinkParamsSchema }) params: In<typeof projectPullLinkParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubPullView }> {
    return { data: await this.github.confirmLink(await this.actions.create(request), params.id, params.linkId) };
  }

  @Post(':id/github/jira-links/:linkId/dismiss')
  @RequirePermission('github.link')
  @ApiResult(githubPullResponseSchema)
  async dismiss(
    @Param({ schema: projectPullLinkParamsSchema }) params: In<typeof projectPullLinkParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: GithubPullView }> {
    return { data: await this.github.dismissLink(await this.actions.create(request), params.id, params.linkId) };
  }
}

/**
 * Pull-request panel of a support ticket. The route permission is the ticket's; the service checks
 * `github.view` / `github.link` on the ticket's project.
 */
@ApiTags('github')
@Controller({ path: 'support/tickets', version: '1' })
export class TicketGithubController {
  constructor(
    @Inject(GithubTicketService) private readonly github: GithubTicketService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id/github')
  @RequirePermission('support.view')
  @ApiResult(ticketGithubPanelResponseSchema)
  async panel(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketGithubPanel }> {
    return { data: await this.github.panel(await this.actions.create(request), params.id) };
  }

  @Get(':id/github/search')
  @RequirePermission('github.link')
  @ApiResult(ticketPullSearchResponseSchema)
  async search(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Query({ schema: ticketPullSearchQuerySchema }) query: In<typeof ticketPullSearchQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketPullOption[] }> {
    return { data: await this.github.searchPulls(await this.actions.create(request), params.id, query.q) };
  }

  @Post(':id/github/links')
  @RequirePermission('github.link')
  @ApiResult(ticketGithubPanelResponseSchema, 201)
  async link(
    @Param({ schema: idParamsSchema }) params: In<typeof idParamsSchema>,
    @Body({ schema: linkTicketPullRequestSchema }) body: In<typeof linkTicketPullRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: TicketGithubPanel }> {
    return { data: await this.github.linkPull(await this.actions.create(request), params.id, body.pullRequestId) };
  }

  @Delete(':id/github/links/:linkId')
  @RequirePermission('github.link')
  @ApiNoContent()
  async unlink(
    @Param({ schema: ticketPullLinkParamsSchema }) params: In<typeof ticketPullLinkParamsSchema>,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.github.unlinkPull(await this.actions.create(request), params.id, params.linkId);
  }
}

/**
 * Retention of technical integration records (webhook deliveries, sync failures). `org.settings.manage`
 * with MFA. Without a policy nothing is purged; audit history and business links are never purged.
 */
@ApiTags('organization')
@Controller({ path: 'organization/retention-policies', version: '1' })
export class RetentionPoliciesController {
  constructor(
    @Inject(RetentionPolicyService) private readonly policies: RetentionPolicyService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('org.settings.manage')
  @ApiResult(retentionPolicyListResponseSchema)
  async list(@Req() request: HttpRequest): Promise<{ data: RetentionPolicyView[] }> {
    return { data: await this.policies.list(await this.actions.create(request)) };
  }

  /** Dry run before saving: how many records the policy would remove now. Deletes nothing. */
  @Get(':category/preview')
  @RequirePermission('org.settings.manage')
  @ApiResult(retentionPreviewResponseSchema)
  async preview(
    @Param({ schema: retentionCategoryParamsSchema }) params: In<typeof retentionCategoryParamsSchema>,
    @Query({ schema: retentionPreviewQuerySchema }) query: In<typeof retentionPreviewQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: RetentionPreview }> {
    return { data: await this.policies.preview(await this.actions.create(request), params.category, query.retainDays) };
  }

  @Put(':category')
  @RequirePermission('org.settings.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(retentionPolicyListResponseSchema)
  async set(
    @Param({ schema: retentionCategoryParamsSchema }) params: In<typeof retentionCategoryParamsSchema>,
    @Body({ schema: setRetentionPolicyRequestSchema }) body: In<typeof setRetentionPolicyRequestSchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: RetentionPolicyView[] }> {
    return { data: await this.policies.set(await this.actions.create(request), params.category, body) };
  }

  @Delete(':category')
  @RequirePermission('org.settings.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(retentionPolicyListResponseSchema)
  async remove(
    @Param({ schema: retentionCategoryParamsSchema }) params: In<typeof retentionCategoryParamsSchema>,
    @Query({ schema: githubVersionQuerySchema }) query: In<typeof githubVersionQuerySchema>,
    @Req() request: HttpRequest,
  ): Promise<{ data: RetentionPolicyView[] }> {
    return { data: await this.policies.remove(await this.actions.create(request), params.category, query.version) };
  }
}
