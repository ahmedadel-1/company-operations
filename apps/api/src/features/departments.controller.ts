import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DepartmentService } from '@company-ops/core';
import type { DepartmentView } from '@company-ops/core';
import {
  createDepartmentRequestSchema,
  departmentListResponseSchema,
  departmentResponseSchema,
  idParamsSchema,
  structureListQuerySchema,
  updateDepartmentRequestSchema,
} from '@company-ops/validation';
import type {
  CreateDepartmentRequest,
  IdParams,
  StructureListQuery,
  UpdateDepartmentRequest,
} from '@company-ops/validation';

import { RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/** Department tree of the active organization (P1-12). Archiving keeps history; nothing is deleted. */
@ApiTags('departments')
@Controller({ path: 'departments', version: '1' })
export class DepartmentsController {
  constructor(
    @Inject(DepartmentService) private readonly departments: DepartmentService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('employee.view')
  @ApiResult(departmentListResponseSchema)
  async list(
    @Query({ schema: structureListQuerySchema }) query: StructureListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: DepartmentView[] }> {
    return { data: await this.departments.list(await this.actions.create(request), query) };
  }

  @Post()
  @RequirePermission('department.manage')
  @ApiResult(departmentResponseSchema, 201)
  async create(
    @Body({ schema: createDepartmentRequestSchema }) body: CreateDepartmentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: DepartmentView }> {
    return { data: await this.departments.create(await this.actions.create(request), body) };
  }

  @Get(':id')
  @RequirePermission('employee.view')
  @ApiResult(departmentResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: DepartmentView }> {
    return { data: await this.departments.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('department.manage')
  @ApiResult(departmentResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateDepartmentRequestSchema }) body: UpdateDepartmentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: DepartmentView }> {
    return { data: await this.departments.update(await this.actions.create(request), params.id, body) };
  }

  @Post(':id/archive')
  @RequirePermission('department.manage')
  @ApiResult(departmentResponseSchema)
  async archive(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: DepartmentView }> {
    return { data: await this.departments.setArchived(await this.actions.create(request), params.id, true) };
  }

  @Post(':id/unarchive')
  @RequirePermission('department.manage')
  @ApiResult(departmentResponseSchema)
  async unarchive(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: DepartmentView }> {
    return { data: await this.departments.setArchived(await this.actions.create(request), params.id, false) };
  }
}
