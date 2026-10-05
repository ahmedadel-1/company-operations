import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import {
  DailyReportService,
  ProjectActivityService,
  ProjectLocationService,
  ProjectMemberService,
  ProjectService,
} from '@company-ops/core';
import type {
  DailyReportSummaryView,
  DailyReportView,
  EmployeeProjectView,
  MissingReportsView,
  Page,
  ProjectActivityView,
  ProjectLocationView,
  ProjectMemberView,
  ProjectSummaryView,
  ProjectView,
} from '@company-ops/core';
import {
  addProjectMemberRequestSchema,
  archiveProjectRequestSchema,
  createProjectRequestSchema,
  dailyReportListQuerySchema,
  dailyReportPageResponseSchema,
  dailyReportResponseSchema,
  employeeProjectListResponseSchema,
  idParamsSchema,
  linkProjectLocationRequestSchema,
  missingReportsQuerySchema,
  missingReportsResponseSchema,
  projectActivityPageResponseSchema,
  projectActivityQuerySchema,
  projectListQuerySchema,
  projectLocationListResponseSchema,
  projectLocationParamsSchema,
  projectLocationResponseSchema,
  projectMemberListResponseSchema,
  projectMemberParamsSchema,
  projectMemberResponseSchema,
  projectPageResponseSchema,
  projectResponseSchema,
  restoreProjectRequestSchema,
  setProjectHealthRequestSchema,
  setProjectStatusRequestSchema,
  submitDailyReportRequestSchema,
  updateProjectMemberRequestSchema,
  updateProjectRequestSchema,
} from '@company-ops/validation';
import type {
  AddProjectMemberRequest,
  ArchiveProjectRequest,
  CreateProjectRequest,
  DailyReportListQuery,
  IdParams,
  LinkProjectLocationRequest,
  MissingReportsQuery,
  ProjectActivityQuery,
  ProjectListQuery,
  ProjectLocationParams,
  ProjectMemberParams,
  RestoreProjectRequest,
  SetProjectHealthRequest,
  SetProjectStatusRequest,
  SubmitDailyReportRequest,
  UpdateProjectMemberRequest,
  UpdateProjectRequest,
} from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest } from '../http/http-types.js';
import { ApiNoContent, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

interface PageBody<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null };
}

const toPage = <T>(page: Page<T>): PageBody<T> => ({ data: page.items, page: { nextCursor: page.nextCursor } });

/**
 * Projects (P2-2..P2-7): list/detail, lifecycle, membership, linked locations, timeline and the
 * project's daily reports. Route permissions are coarse; the services enforce the project scope
 * (out-of-scope projects are 404) and the lifecycle rules.
 */
@ApiTags('projects')
@Controller({ path: 'projects', version: '1' })
export class ProjectsController {
  constructor(
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(ProjectMemberService) private readonly members: ProjectMemberService,
    @Inject(ProjectLocationService) private readonly locations: ProjectLocationService,
    @Inject(ProjectActivityService) private readonly activity: ProjectActivityService,
    @Inject(DailyReportService) private readonly reports: DailyReportService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @RequirePermission('project.view')
  @ApiResult(projectPageResponseSchema)
  async list(
    @Query({ schema: projectListQuerySchema }) query: ProjectListQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<ProjectSummaryView>> {
    return toPage(await this.projects.list(await this.actions.create(request), query));
  }

  @Post()
  @RequirePermission('project.create')
  @ApiResult(projectResponseSchema, 201)
  async create(
    @Body({ schema: createProjectRequestSchema }) body: CreateProjectRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectView }> {
    return { data: await this.projects.create(await this.actions.create(request), body) };
  }

  @Get(':id')
  @RequirePermission('project.view')
  @ApiResult(projectResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectView }> {
    return { data: await this.projects.get(await this.actions.create(request), params.id) };
  }

  @Patch(':id')
  @RequirePermission('project.manage')
  @ApiResult(projectResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateProjectRequestSchema }) body: UpdateProjectRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectView }> {
    const { version, ...changes } = body;
    return { data: await this.projects.update(await this.actions.create(request), params.id, version, changes) };
  }

  @Put(':id/status')
  @RequirePermission('project.manage')
  @ApiResult(projectResponseSchema)
  async setStatus(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: setProjectStatusRequestSchema }) body: SetProjectStatusRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectView }> {
    return { data: await this.projects.setStatus(await this.actions.create(request), params.id, body) };
  }

  @Put(':id/health')
  @RequirePermission('project.manage')
  @ApiResult(projectResponseSchema)
  async setHealth(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: setProjectHealthRequestSchema }) body: SetProjectHealthRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectView }> {
    return { data: await this.projects.setHealth(await this.actions.create(request), params.id, body) };
  }

  @Post(':id/archive')
  @RequirePermission('project.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(projectResponseSchema)
  async archive(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: archiveProjectRequestSchema }) body: ArchiveProjectRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectView }> {
    return { data: await this.projects.archive(await this.actions.create(request), params.id, body) };
  }

  @Post(':id/restore')
  @RequirePermission('project.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(projectResponseSchema)
  async restore(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: restoreProjectRequestSchema }) body: RestoreProjectRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectView }> {
    return { data: await this.projects.restore(await this.actions.create(request), params.id, body) };
  }

  // ---- Members ----

  @Get(':id/members')
  @RequirePermission('project.view')
  @ApiResult(projectMemberListResponseSchema)
  async listMembers(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectMemberView[] }> {
    return { data: await this.members.list(await this.actions.create(request), params.id) };
  }

  @Post(':id/members')
  @RequirePermission('project.assign_members')
  @PrincipalRateLimit('sensitive')
  @ApiResult(projectMemberResponseSchema, 201)
  async addMember(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: addProjectMemberRequestSchema }) body: AddProjectMemberRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectMemberView }> {
    return { data: await this.members.add(await this.actions.create(request), params.id, body) };
  }

  @Patch(':id/members/:employeeId')
  @RequirePermission('project.assign_members')
  @PrincipalRateLimit('sensitive')
  @ApiResult(projectMemberResponseSchema)
  async updateMember(
    @Param({ schema: projectMemberParamsSchema }) params: ProjectMemberParams,
    @Body({ schema: updateProjectMemberRequestSchema }) body: UpdateProjectMemberRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectMemberView }> {
    return {
      data: await this.members.update(await this.actions.create(request), params.id, params.employeeId, body),
    };
  }

  @Delete(':id/members/:employeeId')
  @RequirePermission('project.assign_members')
  @PrincipalRateLimit('sensitive')
  @ApiNoContent()
  async removeMember(
    @Param({ schema: projectMemberParamsSchema }) params: ProjectMemberParams,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.members.remove(await this.actions.create(request), params.id, params.employeeId);
  }

  // ---- Locations ----

  @Get(':id/locations')
  @RequirePermission('project.view')
  @ApiResult(projectLocationListResponseSchema)
  async listLocations(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectLocationView[] }> {
    return { data: await this.locations.list(await this.actions.create(request), params.id) };
  }

  @Post(':id/locations')
  @RequirePermission('project.manage')
  @ApiResult(projectLocationResponseSchema, 201)
  async linkLocation(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: linkProjectLocationRequestSchema }) body: LinkProjectLocationRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ProjectLocationView }> {
    return { data: await this.locations.link(await this.actions.create(request), params.id, body.workLocationId) };
  }

  @Delete(':id/locations/:locationId')
  @RequirePermission('project.manage')
  @ApiNoContent()
  async unlinkLocation(
    @Param({ schema: projectLocationParamsSchema }) params: ProjectLocationParams,
    @Req() request: HttpRequest,
  ): Promise<void> {
    await this.locations.unlink(await this.actions.create(request), params.id, params.locationId);
  }

  // ---- Activity ----

  @Get(':id/activity')
  @RequirePermission('project.view')
  @ApiResult(projectActivityPageResponseSchema)
  async listActivity(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: projectActivityQuerySchema }) query: ProjectActivityQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<ProjectActivityView>> {
    return toPage(await this.activity.list(await this.actions.create(request), params.id, query));
  }

  // ---- Daily reports ----

  @Get(':id/daily-reports')
  @RequirePermission('daily_report.view')
  @ApiResult(dailyReportPageResponseSchema)
  async listReports(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: dailyReportListQuerySchema }) query: DailyReportListQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<DailyReportSummaryView>> {
    return toPage(await this.reports.listForProject(await this.actions.create(request), params.id, query));
  }

  @Post(':id/daily-reports')
  @RequirePermission('daily_report.submit')
  @ApiResult(dailyReportResponseSchema, 201)
  async submitReport(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: submitDailyReportRequestSchema }) body: SubmitDailyReportRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: DailyReportView }> {
    return { data: await this.reports.submit(await this.actions.create(request), params.id, body) };
  }

  /** Derived on request from the policy, staffing and submitted reports (never stored). */
  @Get(':id/daily-reports/missing')
  @RequirePermission('daily_report.view')
  @ApiResult(missingReportsResponseSchema)
  async missingReports(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Query({ schema: missingReportsQuerySchema }) query: MissingReportsQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: MissingReportsView }> {
    return { data: await this.reports.missing(await this.actions.create(request), params.id, query) };
  }
}

@ApiTags('daily-reports')
@Controller({ path: 'daily-reports', version: '1' })
export class DailyReportsController {
  constructor(
    @Inject(DailyReportService) private readonly reports: DailyReportService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id')
  @RequirePermission('daily_report.view')
  @ApiResult(dailyReportResponseSchema)
  async get(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: DailyReportView }> {
    return { data: await this.reports.get(await this.actions.create(request), params.id) };
  }
}

/** `GET /employees/:id/projects`: an employee's projects, limited to the projects the caller may view. */
@ApiTags('employees')
@Controller({ path: 'employees', version: '1' })
export class EmployeeProjectsController {
  constructor(
    @Inject(ProjectService) private readonly projects: ProjectService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get(':id/projects')
  @RequirePermission('project.view')
  @ApiResult(employeeProjectListResponseSchema)
  async list(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: EmployeeProjectView[] }> {
    return { data: await this.projects.listForEmployee(await this.actions.create(request), params.id) };
  }
}
