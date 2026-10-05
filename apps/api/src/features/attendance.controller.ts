import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';

import {
  AttendanceCorrectionService,
  AttendancePolicyService,
  AttendanceService,
  InvalidInputError,
  ShiftService,
} from '@company-ops/core';
import type {
  AttendancePolicyView,
  AttendanceRecordView,
  CheckKind,
  CheckResultView,
  CorrectionView,
  Page,
  RecordDetailView,
  ReviewItemView,
  ShiftAssignmentView,
  ShiftView,
  TeamDayView,
  TodayView,
} from '@company-ops/core';
import {
  adminAttendanceCorrectionSchema,
  attendanceCheckRequestSchema,
  attendanceCheckResponseSchema,
  attendanceCorrectionPageResponseSchema,
  attendanceCorrectionQuerySchema,
  attendanceCorrectionResponseSchema,
  attendanceExportQuerySchema,
  attendanceIdempotencyKeySchema,
  attendancePolicyResponseSchema,
  attendanceRecordDetailResponseSchema,
  attendanceRecordPageResponseSchema,
  attendanceReviewPageResponseSchema,
  attendanceReviewQuerySchema,
  attendanceReviewRequestSchema,
  attendanceTeamDayPageResponseSchema,
  attendanceTeamDayQuerySchema,
  attendanceTodayResponseSchema,
  createAttendanceCorrectionSchema,
  createShiftAssignmentSchema,
  createShiftSchema,
  endShiftAssignmentSchema,
  idParamsSchema,
  myAttendanceQuerySchema,
  setAttendancePolicySchema,
  shiftAssignmentPageResponseSchema,
  shiftAssignmentQuerySchema,
  shiftAssignmentResponseSchema,
  shiftListQuerySchema,
  shiftListResponseSchema,
  shiftResponseSchema,
  teamAttendanceQuerySchema,
  updateShiftSchema,
} from '@company-ops/validation';
import type {
  AdminAttendanceCorrectionRequest,
  AttendanceCheckRequest,
  AttendanceCorrectionQuery,
  AttendanceExportQuery,
  AttendanceReviewQuery,
  AttendanceReviewRequest,
  AttendanceTeamDayQuery,
  CreateAttendanceCorrectionRequest,
  CreateShiftAssignmentRequest,
  CreateShiftRequest,
  EndShiftAssignmentRequest,
  IdParams,
  MyAttendanceQuery,
  SetAttendancePolicyRequest,
  ShiftAssignmentQuery,
  ShiftListQuery,
  TeamAttendanceQuery,
  UpdateShiftRequest,
} from '@company-ops/validation';

import { PrincipalRateLimit, RequirePermission } from '../auth/decorators.js';
import type { HttpRequest, HttpResponse } from '../http/http-types.js';
import { ApiCsv, ApiResult } from '../http/openapi.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';

interface PageBody<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null };
}

const toPage = <T>(page: Page<T>): PageBody<T> => ({ data: page.items, page: { nextCursor: page.nextCursor } });

function idempotencyKey(request: HttpRequest, required: true): string;
function idempotencyKey(request: HttpRequest, required: false): string | undefined;
function idempotencyKey(request: HttpRequest, required: boolean): string | undefined {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) {
    if (required) throw new InvalidInputError('Idempotency-Key', 'The Idempotency-Key header is required.');
    return undefined;
  }
  const parsed = attendanceIdempotencyKeySchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new InvalidInputError('Idempotency-Key', 'The Idempotency-Key header must be a UUID.');
  }
  return parsed.data;
}

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: 'UUID chosen by the client; a retry with the same key returns the original result (200).',
} as const;

/**
 * Attendance for employees, managers and HR (Phase 7, ADR-0022). Location is accepted only on the
 * explicit check-in/check-out calls; the server decides time, work day, location match and result.
 * Coordinates are never returned.
 */
@ApiTags('attendance')
@Controller({ path: 'attendance', version: '1' })
export class AttendanceController {
  constructor(
    @Inject(AttendanceService) private readonly attendance: AttendanceService,
    @Inject(AttendanceCorrectionService) private readonly corrections: AttendanceCorrectionService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get('today')
  @RequirePermission('attendance.self')
  @ApiResult(attendanceTodayResponseSchema)
  async today(@Req() request: HttpRequest): Promise<{ data: TodayView }> {
    return { data: await this.attendance.today(await this.actions.create(request)) };
  }

  @Post('check-in')
  @RequirePermission('attendance.self')
  @PrincipalRateLimit('attendance')
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiResult(attendanceCheckResponseSchema, 201)
  async checkIn(
    @Body({ schema: attendanceCheckRequestSchema }) body: AttendanceCheckRequest,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ data: CheckResultView }> {
    return this.check('CHECK_IN', body, request, response);
  }

  @Post('check-out')
  @RequirePermission('attendance.self')
  @PrincipalRateLimit('attendance')
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiResult(attendanceCheckResponseSchema, 201)
  async checkOut(
    @Body({ schema: attendanceCheckRequestSchema }) body: AttendanceCheckRequest,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ data: CheckResultView }> {
    return this.check('CHECK_OUT', body, request, response);
  }

  @Get('me/records')
  @RequirePermission('attendance.self')
  @ApiResult(attendanceRecordPageResponseSchema)
  async myRecords(
    @Query({ schema: myAttendanceQuerySchema }) query: MyAttendanceQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<AttendanceRecordView>> {
    return toPage(await this.attendance.myRecords(await this.actions.create(request), query));
  }

  @Get('records')
  @RequirePermission('attendance.team')
  @ApiResult(attendanceRecordPageResponseSchema)
  async records(
    @Query({ schema: teamAttendanceQuerySchema }) query: TeamAttendanceQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<AttendanceRecordView>> {
    return toPage(await this.attendance.records(await this.actions.create(request), query));
  }

  @Get('records/:id')
  @ApiResult(attendanceRecordDetailResponseSchema)
  async record(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Req() request: HttpRequest,
  ): Promise<{ data: RecordDetailView }> {
    return { data: await this.attendance.recordDetail(await this.actions.create(request), params.id) };
  }

  @Get('team/day')
  @RequirePermission('attendance.team')
  @ApiResult(attendanceTeamDayPageResponseSchema)
  async teamDay(
    @Query({ schema: attendanceTeamDayQuerySchema }) query: AttendanceTeamDayQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<TeamDayView>> {
    return toPage(await this.attendance.teamDay(await this.actions.create(request), query));
  }

  @Get('reviews')
  @ApiResult(attendanceReviewPageResponseSchema)
  async reviews(
    @Query({ schema: attendanceReviewQuerySchema }) query: AttendanceReviewQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<ReviewItemView>> {
    return toPage(await this.attendance.reviews(await this.actions.create(request), query));
  }

  @Post('events/:id/review')
  @ApiResult(attendanceRecordDetailResponseSchema)
  async review(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: attendanceReviewRequestSchema }) body: AttendanceReviewRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RecordDetailView }> {
    return {
      data: await this.attendance.review(await this.actions.create(request), params.id, body.decision, body.note),
    };
  }

  @Get('export')
  @RequirePermission('attendance.team')
  @ApiCsv()
  async export(
    @Query({ schema: attendanceExportQuerySchema }) query: AttendanceExportQuery,
    @Req() request: HttpRequest,
  ): Promise<StreamableFile> {
    const result = await this.attendance.exportCsv(await this.actions.create(request), query);
    // Byte order mark so spreadsheet applications read UTF-8 (Arabic names) correctly.
    return new StreamableFile(Buffer.from(`\uFEFF${result.csv}`, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="${result.filename}"`,
    });
  }

  @Post('corrections')
  @RequirePermission('attendance.self')
  @ApiHeader({ ...IDEMPOTENCY_HEADER, required: false })
  @ApiResult(attendanceCorrectionResponseSchema, 201)
  async createCorrection(
    @Body({ schema: createAttendanceCorrectionSchema }) body: CreateAttendanceCorrectionRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: CorrectionView }> {
    return {
      data: await this.corrections.submit(await this.actions.create(request), body, idempotencyKey(request, false)),
    };
  }

  @Get('corrections')
  @RequirePermission('attendance.self')
  @ApiResult(attendanceCorrectionPageResponseSchema)
  async myCorrections(
    @Query({ schema: attendanceCorrectionQuerySchema }) query: AttendanceCorrectionQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<CorrectionView>> {
    return toPage(await this.corrections.listMine(await this.actions.create(request), query));
  }

  /** Privileged direct correction (`attendance.admin`, fresh MFA), always with a reason and a note. */
  @Post('admin/corrections')
  @RequirePermission('attendance.admin')
  @ApiResult(attendanceRecordDetailResponseSchema)
  async adminCorrect(
    @Body({ schema: adminAttendanceCorrectionSchema }) body: AdminAttendanceCorrectionRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: RecordDetailView }> {
    return { data: await this.corrections.adminCorrect(await this.actions.create(request), body) };
  }

  private async check(
    kind: CheckKind,
    body: AttendanceCheckRequest,
    request: HttpRequest,
    response: HttpResponse,
  ): Promise<{ data: CheckResultView }> {
    const key = idempotencyKey(request, true);
    const result = await this.attendance.check(await this.actions.create(request), kind, body, key);
    if (result.replayed) response.status(200);
    return { data: result };
  }
}

/** The organization's location accuracy policy (ADR-0022). Changes are privileged (fresh MFA). */
@ApiTags('attendance')
@Controller({ path: 'attendance/policy', version: '1' })
export class AttendancePolicyController {
  constructor(
    @Inject(AttendancePolicyService) private readonly policy: AttendancePolicyService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get()
  @ApiResult(attendancePolicyResponseSchema)
  async get(@Req() request: HttpRequest): Promise<{ data: AttendancePolicyView }> {
    return { data: await this.policy.get(await this.actions.create(request)) };
  }

  @Put()
  @RequirePermission('org.settings.manage')
  @PrincipalRateLimit('sensitive')
  @ApiResult(attendancePolicyResponseSchema)
  async set(
    @Body({ schema: setAttendancePolicySchema }) body: SetAttendancePolicyRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: AttendancePolicyView }> {
    return { data: await this.policy.set(await this.actions.create(request), body) };
  }
}

/** Shifts and shift assignments (`attendance.config`, ORG). Deactivated / ended, never deleted. */
@ApiTags('attendance')
@Controller({ path: 'attendance', version: '1' })
export class ShiftsController {
  constructor(
    @Inject(ShiftService) private readonly shifts: ShiftService,
    @Inject(ActionContextFactory) private readonly actions: ActionContextFactory,
  ) {}

  @Get('shifts')
  @RequirePermission('attendance.config')
  @ApiResult(shiftListResponseSchema)
  async list(
    @Query({ schema: shiftListQuerySchema }) query: ShiftListQuery,
    @Req() request: HttpRequest,
  ): Promise<{ data: ShiftView[] }> {
    return { data: await this.shifts.listShifts(await this.actions.create(request), query.includeInactive === true) };
  }

  @Post('shifts')
  @RequirePermission('attendance.config')
  @ApiResult(shiftResponseSchema, 201)
  async create(
    @Body({ schema: createShiftSchema }) body: CreateShiftRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ShiftView }> {
    return { data: await this.shifts.createShift(await this.actions.create(request), body) };
  }

  @Patch('shifts/:id')
  @RequirePermission('attendance.config')
  @ApiResult(shiftResponseSchema)
  async update(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: updateShiftSchema }) body: UpdateShiftRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ShiftView }> {
    return { data: await this.shifts.updateShift(await this.actions.create(request), params.id, body) };
  }

  @Get('shift-assignments')
  @RequirePermission('attendance.config')
  @ApiResult(shiftAssignmentPageResponseSchema)
  async assignments(
    @Query({ schema: shiftAssignmentQuerySchema }) query: ShiftAssignmentQuery,
    @Req() request: HttpRequest,
  ): Promise<PageBody<ShiftAssignmentView>> {
    return toPage(await this.shifts.listAssignments(await this.actions.create(request), query));
  }

  @Post('shift-assignments')
  @RequirePermission('attendance.config')
  @ApiResult(shiftAssignmentResponseSchema, 201)
  async assign(
    @Body({ schema: createShiftAssignmentSchema }) body: CreateShiftAssignmentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ShiftAssignmentView }> {
    return { data: await this.shifts.createAssignment(await this.actions.create(request), body) };
  }

  @Post('shift-assignments/:id/end')
  @RequirePermission('attendance.config')
  @ApiResult(shiftAssignmentResponseSchema)
  async end(
    @Param({ schema: idParamsSchema }) params: IdParams,
    @Body({ schema: endShiftAssignmentSchema }) body: EndShiftAssignmentRequest,
    @Req() request: HttpRequest,
  ): Promise<{ data: ShiftAssignmentView }> {
    return { data: await this.shifts.endAssignment(await this.actions.create(request), params.id, body) };
  }
}
