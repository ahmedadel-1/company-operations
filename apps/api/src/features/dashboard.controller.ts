import { Body, Controller, Get, Inject, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  DashboardService,
  NeedsAttentionService,
  NotificationPreferenceService,
  SearchService,
  SetupChecklistService,
} from '@company-ops/core';
import type {
  CommercialDashboard,
  ExecutiveDashboard,
  MeDashboard,
  NeedsAttention,
  NotificationPreferenceItem,
  ProjectsDashboard,
  SearchResponse,
  SetupChecklist,
  SupportDashboard,
  TeamDashboard,
  Trend,
} from '@company-ops/core';
import {
  commercialDashboardResponseSchema,
  executiveDashboardResponseSchema,
  meDashboardResponseSchema,
  needsAttentionResponseSchema,
  notificationPreferencesResponseSchema,
  projectsDashboardResponseSchema,
  searchQuerySchema,
  searchResponseSchema,
  setupChecklistResponseSchema,
  supportDashboardResponseSchema,
  teamDashboardResponseSchema,
  trendQuerySchema,
  trendResponseSchema,
  updateNotificationPreferencesSchema,
} from '@company-ops/validation';
import type { SearchQuery, TrendQuery, UpdateNotificationPreferences } from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/**
 * Role dashboards, Needs Attention and trends (Phase 8, ADR-0023). Read-only: every number is
 * computed by the core read services from the caller's server-resolved scope; each route re-checks
 * its permission, so a hidden card is never the security boundary.
 */
@ApiTags('dashboard')
@Controller({ path: 'dashboard', version: '1' })
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly dashboards: DashboardService,
    @Inject(NeedsAttentionService) private readonly attention: NeedsAttentionService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get('me')
  @ApiResult(meDashboardResponseSchema)
  async me(@Req() request: HttpRequest): Promise<{ data: MeDashboard }> {
    return { data: await this.dashboards.me(await this.actions.create(request)) };
  }

  @Get('team')
  @RequirePermission('attendance.team')
  @ApiResult(teamDashboardResponseSchema)
  async team(@Req() request: HttpRequest): Promise<{ data: TeamDashboard }> {
    return { data: await this.dashboards.team(await this.actions.create(request)) };
  }

  /** Members who work tickets (`support.view` beyond their own reported tickets). */
  @Get('support')
  @RequirePermission('support.view')
  @ApiResult(supportDashboardResponseSchema)
  async support(@Req() request: HttpRequest): Promise<{ data: SupportDashboard }> {
    return { data: await this.dashboards.support(await this.actions.create(request)) };
  }

  @Get('projects')
  @RequirePermission('dashboard.project')
  @ApiResult(projectsDashboardResponseSchema)
  async projects(@Req() request: HttpRequest): Promise<{ data: ProjectsDashboard }> {
    return { data: await this.dashboards.projects(await this.actions.create(request)) };
  }

  @Get('executive')
  @RequirePermission('dashboard.executive')
  @ApiResult(executiveDashboardResponseSchema)
  async executive(@Req() request: HttpRequest): Promise<{ data: ExecutiveDashboard }> {
    return { data: await this.dashboards.executive(await this.actions.create(request)) };
  }

  /** Tenders, contracts, guarantees and corporate documents (Phase 10); any commercial view permission. */
  @Get('commercial')
  @ApiResult(commercialDashboardResponseSchema)
  async commercial(@Req() request: HttpRequest): Promise<{ data: CommercialDashboard }> {
    return { data: await this.dashboards.commercial(await this.actions.create(request)) };
  }

  @Get('needs-attention')
  @ApiResult(needsAttentionResponseSchema)
  async needsAttention(@Req() request: HttpRequest): Promise<{ data: NeedsAttention }> {
    return { data: await this.attention.list(await this.actions.create(request)) };
  }

  /** Daily series from stored history; the permission depends on the metric. */
  @Get('trends')
  @ApiResult(trendResponseSchema)
  async trends(
    @Query({ schema: trendQuerySchema }) query: TrendQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: Trend }> {
    return {
      data: await this.dashboards.trend(await this.actions.create(request), query.metric, query.range ?? '30d'),
    };
  }
}

/** Global search (P8-6): PostgreSQL only, authorization applied in each entity's `where`. */
@ApiTags('search')
@Controller({ path: 'search', version: '1' })
export class SearchController {
  constructor(
    @Inject(SearchService) private readonly searchService: SearchService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @PrincipalRateLimit('search')
  @ApiResult(searchResponseSchema)
  async search(
    @Query({ schema: searchQuerySchema }) query: SearchQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: SearchResponse }> {
    return {
      data: await this.searchService.search(await this.actions.create(request), {
        q: query.q,
        types: query.types,
        limit: query.limit,
        cursor: query.cursor,
        locale: query.locale,
      }),
    };
  }
}

/** First-run setup checklist (P8-7), derived from real organization state on every request. */
@ApiTags('organization')
@Controller({ path: 'organization/setup-checklist', version: '1' })
export class SetupChecklistController {
  constructor(
    @Inject(SetupChecklistService) private readonly checklist: SetupChecklistService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('org.settings.manage')
  @ApiResult(setupChecklistResponseSchema)
  async get(@Req() request: HttpRequest): Promise<{ data: SetupChecklist }> {
    return { data: await this.checklist.get(await this.actions.create(request)) };
  }
}

/** The caller's own notification preferences (P8-8); security and critical notices are locked on. */
@ApiTags('notifications')
@Controller({ path: 'notifications/preferences', version: '1' })
export class NotificationPreferencesController {
  constructor(
    @Inject(NotificationPreferenceService) private readonly preferences: NotificationPreferenceService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(notificationPreferencesResponseSchema)
  async get(@Req() request: HttpRequest): Promise<{ data: { items: NotificationPreferenceItem[] } }> {
    return { data: await this.preferences.get(await this.actions.create(request)) };
  }

  @Put()
  @ApiResult(notificationPreferencesResponseSchema)
  async update(
    @Body({ schema: updateNotificationPreferencesSchema }) body: UpdateNotificationPreferences,
    @Req() request: HttpRequest,
  ): Promise<{ data: { items: NotificationPreferenceItem[] } }> {
    return { data: await this.preferences.update(await this.actions.create(request), body.items) };
  }
}
