import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { WorkLocationService } from '@company-ops/core';
import type { WorkLocationView } from '@company-ops/core';
import {
  createWorkLocationRequestSchema,
  idParamsSchema,
  updateWorkLocationRequestSchema,
  workLocationListQuerySchema,
  workLocationListResponseSchema,
  workLocationResponseSchema,
} from '@company-ops/validation';
import type {
  CreateWorkLocationRequest,
  IdParams,
  UpdateWorkLocationRequest,
  WorkLocationListQuery,
} from '@company-ops/validation';

import { RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/**
 * Work locations (P2-5): geofenced places shared by projects and, from Phase 7, attendance.
 * Managed with `attendance.config` at ORG scope; deactivated, never deleted.
 */
@ApiTags('work-locations')
@Controller({ path: 'work-locations', version: '1' })
export class WorkLocationsController {
  constructor(
    @Inject(WorkLocationService) private readonly locations: WorkLocationService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(workLocationListResponseSchema)
  async list(
    @Query({ schema: workLocationListQuerySchema }) query: WorkLocationListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: WorkLocationView[] }> {
    return { data: await this.locations.list(await this.actions.create(request), query) };
  }

  @Post()
  @RequirePermission('attendance.config')
  @ApiResult(workLocationResponseSchema, 201)
  async create(
    @Body({ schema: createWorkLocationRequestSchema }) body: CreateWorkLocationRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: WorkLocationView }> {
    return { data: await this.locations.create(await this.actions.create(request), body) };
  }

  @Patch(':id')
  @RequirePermission('attendance.config')
  @ApiResult(workLocationResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateWorkLocationRequestSchema }) body: UpdateWorkLocationRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: WorkLocationView }> {
    return { data: await this.locations.update(await this.actions.create(request), params.id, body) };
  }
}
