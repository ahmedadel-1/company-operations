import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { JobTitleService } from '@company-ops/core';
import type { JobTitleView } from '@company-ops/core';
import {
  createJobTitleRequestSchema,
  idParamsSchema,
  jobTitleListResponseSchema,
  jobTitleResponseSchema,
  structureListQuerySchema,
  updateJobTitleRequestSchema,
} from '@company-ops/validation';
import type {
  CreateJobTitleRequest,
  IdParams,
  StructureListQuery,
  UpdateJobTitleRequest,
} from '@company-ops/validation';

import { RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/** Job title catalog of the active organization (P1-12). */
@ApiTags('job-titles')
@Controller({ path: 'job-titles', version: '1' })
export class JobTitlesController {
  constructor(
    @Inject(JobTitleService) private readonly jobTitles: JobTitleService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('employee.view')
  @ApiResult(jobTitleListResponseSchema)
  async list(
    @Query({ schema: structureListQuerySchema }) query: StructureListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: JobTitleView[] }> {
    return { data: await this.jobTitles.list(await this.actions.create(request), query) };
  }

  @Post()
  @RequirePermission('department.manage')
  @ApiResult(jobTitleResponseSchema, 201)
  async create(
    @Body({ schema: createJobTitleRequestSchema }) body: CreateJobTitleRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: JobTitleView }> {
    return { data: await this.jobTitles.create(await this.actions.create(request), body.name) };
  }

  @Patch(':id')
  @RequirePermission('department.manage')
  @ApiResult(jobTitleResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateJobTitleRequestSchema }) body: UpdateJobTitleRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: JobTitleView }> {
    return { data: await this.jobTitles.update(await this.actions.create(request), params.id, body) };
  }
}
