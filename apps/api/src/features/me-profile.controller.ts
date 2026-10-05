import { Body, Controller, Get, Inject, Patch, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { EmployeeService } from '@company-ops/core';
import type { EmployeeView } from '@company-ops/core';
import {
  employeeResponseSchema,
  ownProfileResponseSchema,
  updateOwnProfileRequestSchema,
} from '@company-ops/validation';
import type { UpdateOwnProfileRequest } from '@company-ops/validation';

import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/** The caller's own employee profile; members may change their phone, time zone and locale. */
@ApiTags('me')
@Controller({ path: 'me/profile', version: '1' })
export class MeProfileController {
  constructor(
    @Inject(EmployeeService) private readonly employees: EmployeeService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(ownProfileResponseSchema)
  async get(@Req() request: HttpRequest): Promise<{ data: EmployeeView | null }> {
    return { data: await this.employees.getOwn(await this.actions.create(request)) };
  }

  @Patch()
  @ApiResult(employeeResponseSchema)
  async update(
    @Body({ schema: updateOwnProfileRequestSchema }) body: UpdateOwnProfileRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: EmployeeView }> {
    return { data: await this.employees.updateOwn(await this.actions.create(request), body) };
  }
}
