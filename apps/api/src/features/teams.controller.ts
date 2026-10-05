import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { TeamService } from '@company-ops/core';
import type { TeamMemberView, TeamView } from '@company-ops/core';
import {
  createTeamRequestSchema,
  idParamsSchema,
  structureListQuerySchema,
  teamListResponseSchema,
  teamMemberAddedResponseSchema,
  teamMemberListResponseSchema,
  teamMemberParamsSchema,
  teamResponseSchema,
  updateTeamRequestSchema,
} from '@company-ops/validation';
import type {
  CreateTeamRequest,
  IdParams,
  StructureListQuery,
  TeamMemberParams,
  UpdateTeamRequest,
} from '@company-ops/validation';

import { RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiNoContent, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

/** Teams and their members (P1-12). Members and leads must be employees of the same organization. */
@ApiTags('teams')
@Controller({ path: 'teams', version: '1' })
export class TeamsController {
  constructor(
    @Inject(TeamService) private readonly teams: TeamService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('employee.view')
  @ApiResult(teamListResponseSchema)
  async list(
    @Query({ schema: structureListQuerySchema }) query: StructureListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: TeamView[] }> {
    return { data: await this.teams.list(await this.actions.create(request), query) };
  }

  @Post()
  @RequirePermission('department.manage')
  @ApiResult(teamResponseSchema, 201)
  async create(
    @Body({ schema: createTeamRequestSchema }) body: CreateTeamRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TeamView }> {
    return { data: await this.teams.create(await this.actions.create(request), body) };
  }

  @Get(':id')
  @RequirePermission('employee.view')
  @ApiResult(teamResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TeamView }> {
    return { data: await this.teams.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('department.manage')
  @ApiResult(teamResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateTeamRequestSchema }) body: UpdateTeamRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: TeamView }> {
    return { data: await this.teams.update(await this.actions.create(request), params.id, body) };
  }

  @Post(':id/archive')
  @RequirePermission('department.manage')
  @ApiResult(teamResponseSchema)
  async archive(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TeamView }> {
    return { data: await this.teams.setArchived(await this.actions.create(request), params.id, true) };
  }

  @Post(':id/unarchive')
  @RequirePermission('department.manage')
  @ApiResult(teamResponseSchema)
  async unarchive(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TeamView }> {
    return { data: await this.teams.setArchived(await this.actions.create(request), params.id, false) };
  }

  @Get(':id/members')
  @RequirePermission('employee.view')
  @ApiResult(teamMemberListResponseSchema)
  async members(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: TeamMemberView[] }> {
    return { data: await this.teams.listMembers(await this.actions.create(request), params.id) };
  }

  /** Idempotent: adding an existing member returns `created: false`. */
  @Put(':id/members/:employeeId')
  @RequirePermission('department.manage')
  @ApiResult(teamMemberAddedResponseSchema)
  async addMember(
    @Param({ schema: teamMemberParamsSchema }) params: TeamMemberParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: { created: boolean } }> {
    return { data: await this.teams.addMember(await this.actions.create(request), params.id, params.employeeId) };
  }

  @Delete(':id/members/:employeeId')
  @RequirePermission('department.manage')
  @ApiNoContent()
  async removeMember(
    @Param({ schema: teamMemberParamsSchema }) params: TeamMemberParams,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.teams.removeMember(await this.actions.create(request), params.id, params.employeeId);
  }
}
