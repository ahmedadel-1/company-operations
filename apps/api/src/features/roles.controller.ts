import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { RoleAdminService, RoleGrantService } from '@company-ops/core';
import type { MemberRoleView, RoleView } from '@company-ops/core';
import {
  createRoleRequestSchema,
  grantRoleRequestSchema,
  grantRoleResponseSchema,
  memberParamsSchema,
  memberRoleListResponseSchema,
  memberRoleParamsSchema,
  roleListResponseSchema,
  roleParamsSchema,
  roleResponseSchema,
  updateRoleRequestSchema,
} from '@company-ops/validation';
import type {
  CreateRoleRequest,
  GrantRoleRequest,
  MemberParams,
  MemberRoleParams,
  RoleParams,
  UpdateRoleRequest,
} from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiNoContent, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/**
 * Roles and role grants (P1-10). Grants need `role.manage` at ORG scope plus fresh MFA; members
 * cannot change their own roles, only organization admins may grant or revoke admin-equivalent
 * roles, and the last active admin cannot be removed. Every change is audited.
 */
@ApiTags('roles')
@Controller({ version: '1' })
export class RolesController {
  constructor(
    @Inject(RoleGrantService) private readonly grants: RoleGrantService,
    @Inject(RoleAdminService) private readonly roleAdmin: RoleAdminService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get('roles')
  @RequirePermission('employee.view')
  @ApiResult(roleListResponseSchema)
  async roles(@Req() request: HttpRequest): Promise<{ data: RoleView[] }> {
    return { data: await this.grants.listRoles(await this.actions.create(request)) };
  }

  /** Custom role (P9-8); see `RoleAdminService` for the escalation rules. */
  @Post('roles')
  @RequirePermission('role.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(roleResponseSchema, 201)
  async createRole(
    @Body({ schema: createRoleRequestSchema }) body: CreateRoleRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RoleView }> {
    return { data: await this.roleAdmin.create(await this.actions.create(request), body) };
  }

  @Patch('roles/:roleId')
  @RequirePermission('role.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(roleResponseSchema)
  async updateRole(
    @Param({ schema: roleParamsSchema }) params: RoleParams,
    @Body({ schema: updateRoleRequestSchema }) body: UpdateRoleRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RoleView }> {
    return { data: await this.roleAdmin.update(await this.actions.create(request), params.roleId, body) };
  }

  @Delete('roles/:roleId')
  @RequirePermission('role.manage')
  @PrincipalRateLimit('sensitive')
  @ApiNoContent()
  async deleteRole(
    @Param({ schema: roleParamsSchema }) params: RoleParams,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.roleAdmin.delete(await this.actions.create(request), params.roleId);
  }

  @Get('members/:memberId/roles')
  @RequirePermission('employee.view')
  @ApiResult(memberRoleListResponseSchema)
  async memberRoles(
    @Param({ schema: memberParamsSchema }) params: MemberParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: MemberRoleView[] }> {
    return { data: await this.grants.listMemberRoles(await this.actions.create(request), params.memberId) };
  }

  /** Idempotent: granting a role the member already holds returns `created: false`. */
  @Post('members/:memberId/roles')
  @RequirePermission('role.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(grantRoleResponseSchema)
  async grant(
    @Param({ schema: memberParamsSchema }) params: MemberParams,
    @Body({ schema: grantRoleRequestSchema }) body: GrantRoleRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: { created: boolean } }> {
    const result = await this.grants.grant(await this.actions.create(request), params.memberId, body.roleId);
    return { data: { created: result.created } };
  }

  @Delete('members/:memberId/roles/:roleId')
  @RequirePermission('role.manage')
  @PrincipalRateLimit('sensitive')
  @ApiNoContent()
  async revoke(
    @Param({ schema: memberRoleParamsSchema }) params: MemberRoleParams,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.grants.revoke(await this.actions.create(request), params.memberId, params.roleId);
  }
}
