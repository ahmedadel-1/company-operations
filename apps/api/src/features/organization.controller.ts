import { Body, Controller, Get, Inject, Patch, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { OrganizationSettingsService } from '@company-ops/core';
import type { OrganizationView } from '@company-ops/core';
import { organizationResponseSchema, updateOrganizationRequestSchema } from '@company-ops/validation';
import type { UpdateOrganizationRequest } from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/** Settings of the active organization (P1-12). */
@ApiTags('organization')
@Controller({ path: 'organization', version: '1' })
export class OrganizationController {
  constructor(
    @Inject(OrganizationSettingsService) private readonly settings: OrganizationSettingsService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(organizationResponseSchema)
  async get(@Req() request: HttpRequest): Promise<{ data: OrganizationView }> {
    return { data: await this.settings.get(await this.actions.create(request)) };
  }

  @Patch()
  @RequirePermission('org.settings.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(organizationResponseSchema)
  async update(
    @Body({ schema: updateOrganizationRequestSchema }) body: UpdateOrganizationRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: OrganizationView }> {
    return { data: await this.settings.update(await this.actions.create(request), body) };
  }
}
