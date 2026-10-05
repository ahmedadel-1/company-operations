import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AuditQueryService } from '@company-ops/core';
import type { AuditEventView } from '@company-ops/core';
import {
  auditEventListQuerySchema,
  auditEventPageResponseSchema,
  auditEventResponseSchema,
  idParamsSchema,
} from '@company-ops/validation';
import type { AuditEventListQuery, IdParams } from '@company-ops/validation';

import { RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/**
 * Read-only audit trail of the active organization (P1-13). There are no write endpoints: rows
 * are append-only (database grants and triggers). Platform audit is not reachable here.
 */
@ApiTags('audit')
@Controller({ path: 'audit/events', version: '1' })
export class AuditController {
  constructor(
    @Inject(AuditQueryService) private readonly audit: AuditQueryService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('audit.view')
  @ApiResult(auditEventPageResponseSchema)
  async list(
    @Query({ schema: auditEventListQuerySchema }) query: AuditEventListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: readonly AuditEventView[]; page: { nextCursor: string | null } }> {
    const page = await this.audit.list(await this.actions.create(request), query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  @Get(':id')
  @RequirePermission('audit.view')
  @ApiResult(auditEventResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: AuditEventView }> {
    return { data: await this.audit.get(await this.actions.create(request), params.id) };
  }
}
