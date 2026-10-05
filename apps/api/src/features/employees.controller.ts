import { Body, Controller, Delete, Get, Header, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { AttachmentService, EmployeeService, NotFoundError } from '@company-ops/core';
import type { EmployeeView } from '@company-ops/core';
import {
  createEmployeeRequestSchema,
  createEmployeeResponseSchema,
  downloadUrlResponseSchema,
  employeeListQuerySchema,
  employeePageResponseSchema,
  employeeResponseSchema,
  idParamsSchema,
  invitationResponseSchema,
  setAvatarRequestSchema,
  setMemberStatusRequestSchema,
  updateEmployeeRequestSchema,
} from '@company-ops/validation';
import type {
  CreateEmployeeRequest,
  EmployeeListQuery,
  IdParams,
  Invitation,
  SetAvatarRequest,
  SetMemberStatusRequest,
  UpdateEmployeeRequest,
} from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import { API_ENV } from '../config/api-env.js';
import type { ApiEnv } from '../config/api-env.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiNoContent, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';
import { invitationLink } from './invitation-link.js';

/**
 * Employees of the active organization (P1-12). The route permission is a coarse capability check;
 * the service enforces the scope of every read and write (out of scope = 404, visible but not
 * manageable = 403).
 */
@ApiTags('employees')
@Controller({ path: 'employees', version: '1' })
export class EmployeesController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(EmployeeService) private readonly employees: EmployeeService,
    @Inject(AttachmentService) private readonly attachments: AttachmentService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('employee.view')
  @ApiResult(employeePageResponseSchema)
  async list(
    @Query({ schema: employeeListQuerySchema }) query: EmployeeListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: readonly EmployeeView[]; page: { nextCursor: string | null } }> {
    const page = await this.employees.list(await this.actions.create(request), query);
    return { data: page.items, page: { nextCursor: page.nextCursor } };
  }

  /** Creates the profile and an INVITED membership; the invitation link is returned once. */
  @Post()
  @RequirePermission('employee.manage')
  @PrincipalRateLimit('sensitive')
  @Header('Cache-Control', 'no-store')
  @ApiResult(createEmployeeResponseSchema, 201)
  async create(
    @Body({ schema: createEmployeeRequestSchema }) body: CreateEmployeeRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: { employee: EmployeeView; invitation: Invitation } }> {
    const result = await this.employees.create(await this.actions.create(request), body);
    return {
      data: { employee: result.employee, invitation: invitationLink(this.env.APP_PUBLIC_URL, result.invitation) },
    };
  }

  @Get(':id')
  @RequirePermission('employee.view')
  @ApiResult(employeeResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: EmployeeView }> {
    return { data: await this.employees.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('employee.manage')
  @ApiResult(employeeResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateEmployeeRequestSchema }) body: UpdateEmployeeRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: EmployeeView }> {
    return { data: await this.employees.update(await this.actions.create(request), params.id, body) };
  }

  /** Enables or disables the membership (sessions of a disabled member end on their next request). */
  @Put(':id/status')
  @RequirePermission('employee.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(employeeResponseSchema)
  async setStatus(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: setMemberStatusRequestSchema }) body: SetMemberStatusRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: EmployeeView }> {
    return { data: await this.employees.setMemberStatus(await this.actions.create(request), params.id, body.status) };
  }

  /** Issues a new invitation for an INVITED member; any previous link stops working. */
  @Post(':id/invitation')
  @RequirePermission('employee.manage')
  @PrincipalRateLimit('sensitive')
  @Header('Cache-Control', 'no-store')
  @ApiResult(invitationResponseSchema, 201)
  async reissueInvitation(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: Invitation }> {
    const issued = await this.employees.reissueInvitation(await this.actions.create(request), params.id);
    return { data: invitationLink(this.env.APP_PUBLIC_URL, issued) };
  }

  @Delete(':id/invitation')
  @RequirePermission('employee.manage')
  @PrincipalRateLimit('sensitive')
  @ApiNoContent()
  async revokeInvitation(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.employees.revokeInvitation(await this.actions.create(request), params.id);
  }

  /** Sets (an AVAILABLE avatar attachment of this employee) or clears the avatar. Self or `employee.manage`. */
  @Put(':id/avatar')
  @ApiResult(employeeResponseSchema)
  async setAvatar(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: setAvatarRequestSchema }) body: SetAvatarRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: EmployeeView }> {
    return { data: await this.employees.setAvatar(await this.actions.create(request), params.id, body.attachmentId) };
  }

  /** Short-lived download URL of the employee's avatar, for callers who may view the employee. */
  @Get(':id/avatar-url')
  @RequirePermission('employee.view')
  @Header('Cache-Control', 'no-store')
  @ApiResult(downloadUrlResponseSchema)
  async avatarUrl(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: { url: string } }> {
    const action = await this.actions.create(request);
    const avatar = await this.employees.avatarAccess(action, params.id);
    if (!avatar.canView || avatar.avatarAttachmentId === null) {
      throw new NotFoundError('Avatar');
    }
    return { data: { url: await this.attachments.downloadUrl(action, avatar.avatarAttachmentId) } };
  }
}
