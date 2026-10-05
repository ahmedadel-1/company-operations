import { Controller, Get, Header, Inject, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { failedJobListResponseSchema } from '@company-ops/validation';
import type { FailedJob } from '@company-ops/validation';

import { RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';
import { FailedJobsService } from './failed-jobs.service.js';

@ApiTags('admin')
@Controller({ path: 'admin/failed-jobs', version: '1' })
export class FailedJobsController {
  constructor(
    @Inject(FailedJobsService) private readonly failedJobs: FailedJobsService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('org.settings.manage')
  @Header('Cache-Control', 'no-store')
  @ApiResult(failedJobListResponseSchema)
  async list(@Req() request: HttpRequest): Promise<{ data: FailedJob[] }> {
    return { data: await this.failedJobs.list(await this.actions.create(request)) };
  }
}
