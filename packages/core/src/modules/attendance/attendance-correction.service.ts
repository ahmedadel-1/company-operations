import type { Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { lockAttendanceProfile } from '../../platform/db/sql/attendance.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { assertPermission } from '../authorization/policy.js';
import { addDays, fromDateOnly, localToday, toDateOnly } from '../projects/business-date.js';
import { holdsOrgWide } from '../projects/project-access.js';
import type { RequestService } from '../requests/request.service.js';
import { AttendanceError } from './attendance-errors.js';
import {
  announceAttendanceChange,
  assignedShifts,
  attendanceZone,
  canRecordAttendance,
  ensureRecord,
  findRecord,
  loadEmployeeByMember,
  loadEmployeeByProfile,
  rederiveRecord,
  runningShifts,
} from './attendance-store.js';
import type { RecordRow } from './attendance-store.js';
import { correctionReasonOption, ensureCorrectionType } from './correction-type.js';
import { correctedInstant, parseLocalTime } from './engine/time.js';
import type { AttendanceService, RecordDetailView } from './attendance.service.js';

export type AdjustmentReason =
  'FORGOT_CHECK_IN' | 'FORGOT_CHECK_OUT' | 'WRONG_LOCATION' | 'SYSTEM_ISSUE' | 'INCORRECT_TIME';
export type CorrectionStatus = 'PENDING' | 'APPLIED' | 'REJECTED' | 'CANCELLED' | 'REVERTED';

export interface CorrectionTimesInput {
  readonly checkIn?: string | undefined;
  readonly checkOut?: string | undefined;
  readonly checkOutNextDay?: boolean | undefined;
}

export interface CreateCorrectionInput extends CorrectionTimesInput {
  readonly workDate: string;
  readonly reasonCode: AdjustmentReason;
  readonly details: string;
}

export interface AdminCorrectionInput extends CorrectionTimesInput {
  readonly profileId: string;
  readonly workDate: string;
  readonly reasonCode: AdjustmentReason;
  readonly note: string;
  readonly version: number | null;
}

export interface CorrectionView {
  readonly id: string;
  readonly workDate: string;
  readonly reasonCode: AdjustmentReason;
  readonly requestedCheckInAt: string | null;
  readonly requestedCheckOutAt: string | null;
  readonly originalCheckInAt: string | null;
  readonly originalCheckOutAt: string | null;
  readonly details: string;
  readonly status: CorrectionStatus;
  readonly request: { readonly id: string; readonly number: number };
  readonly appliedAt: string | null;
  readonly revertedAt: string | null;
  readonly createdAt: string;
}

/** Employees may correct the current day and up to 31 days back (ADR-0022). */
export const CORRECTION_MAX_DAYS_BACK = 31;
/** Administrators may correct up to a year back. */
const ADMIN_MAX_DAYS_BACK = 366;

const correctionSelect = {
  id: true,
  workDate: true,
  reasonCode: true,
  requestedCheckInAt: true,
  requestedCheckOutAt: true,
  originalCheckInAt: true,
  originalCheckOutAt: true,
  details: true,
  appliedAt: true,
  revertedAt: true,
  createdAt: true,
  request: { select: { id: true, number: true, status: true } },
} satisfies Prisma.AttendanceAdjustmentRequestSelect;

type CorrectionRow = Prisma.AttendanceAdjustmentRequestGetPayload<{ select: typeof correctionSelect }>;

export function correctionStatus(row: {
  appliedAt: Date | null;
  revertedAt: Date | null;
  request: { status: string };
}): CorrectionStatus {
  if (row.revertedAt !== null) return 'REVERTED';
  if (row.appliedAt !== null) return 'APPLIED';
  if (row.request.status === 'REJECTED') return 'REJECTED';
  if (row.request.status === 'CANCELLED') return 'CANCELLED';
  return 'PENDING';
}

const toCorrectionView = (row: CorrectionRow): CorrectionView => ({
  id: row.id,
  workDate: toDateOnly(row.workDate) ?? '',
  reasonCode: row.reasonCode,
  requestedCheckInAt: row.requestedCheckInAt?.toISOString() ?? null,
  requestedCheckOutAt: row.requestedCheckOutAt?.toISOString() ?? null,
  originalCheckInAt: row.originalCheckInAt?.toISOString() ?? null,
  originalCheckOutAt: row.originalCheckOutAt?.toISOString() ?? null,
  details: row.details,
  status: correctionStatus(row),
  request: { id: row.request.id, number: row.request.number },
  appliedAt: row.appliedAt?.toISOString() ?? null,
  revertedAt: row.revertedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Corrected instants for a work date, validated against what the record already holds: a check-out
 * needs a check-in, ends after it, and nothing is in the future. A check-out earlier than the corrected
 * check-in is taken as the next day unless the caller said otherwise (overnight shifts).
 */
export function correctedTimes(
  workDate: string,
  timeZone: string,
  input: CorrectionTimesInput,
  existing: { checkInAt: Date | null; checkOutAt: Date | null } | null,
  now: Date,
): { checkInAt: Date | null; checkOutAt: Date | null } {
  if (input.checkIn === undefined && input.checkOut === undefined) {
    throw new InvalidInputError('checkIn', 'A corrected check-in or check-out is required.');
  }
  const checkInAt = input.checkIn === undefined ? null : correctedInstant(workDate, input.checkIn, false, timeZone);
  const nextDay =
    input.checkOutNextDay ??
    (input.checkOut !== undefined &&
      input.checkIn !== undefined &&
      parseLocalTime(input.checkOut) <= parseLocalTime(input.checkIn));
  const checkOutAt =
    input.checkOut === undefined ? null : correctedInstant(workDate, input.checkOut, nextDay, timeZone);
  if (checkInAt !== null && checkInAt.getTime() > now.getTime()) {
    throw new InvalidInputError('checkIn', 'The corrected check-in cannot be in the future.');
  }
  if (checkOutAt !== null && checkOutAt.getTime() > now.getTime()) {
    throw new InvalidInputError('checkOut', 'The corrected check-out cannot be in the future.');
  }
  const effectiveIn = checkInAt ?? existing?.checkInAt ?? null;
  const effectiveOut = checkOutAt ?? existing?.checkOutAt ?? null;
  if (checkOutAt !== null && effectiveIn === null) {
    throw new InvalidInputError('checkIn', 'A check-out correction needs a check-in for that day.');
  }
  if (effectiveIn !== null && effectiveOut !== null && effectiveOut.getTime() <= effectiveIn.getTime()) {
    throw new InvalidInputError('checkOut', 'The check-out must be after the check-in.');
  }
  return { checkInAt, checkOutAt };
}

function assertReasonMatches(reason: AdjustmentReason, input: CorrectionTimesInput): void {
  if (reason === 'FORGOT_CHECK_IN' && input.checkIn === undefined) {
    throw new InvalidInputError('checkIn', 'A forgotten check-in needs the corrected check-in time.');
  }
  if (reason === 'FORGOT_CHECK_OUT' && input.checkOut === undefined) {
    throw new InvalidInputError('checkOut', 'A forgotten check-out needs the corrected check-out time.');
  }
}

/**
 * Attendance corrections (ADR-0022). Employees request a correction, which becomes a Phase 6 request of
 * the reserved `attendance_correction` type in the same transaction (no second approval engine); the
 * worker applies the trusted adjustment row after final approval. Administrators with `attendance.admin`
 * may correct directly (fresh MFA at the controller), always with a reason and a note, audited. Original
 * evidence is never edited.
 */
export class AttendanceCorrectionService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly requests: RequestService,
    private readonly attendance: AttendanceService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async submit(action: ActionContext, input: CreateCorrectionInput, idempotencyKey?: string): Promise<CorrectionView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.self');
    assertPermission(action.principal, 'request.create');
    assertReasonMatches(input.reasonCode, input);
    if (idempotencyKey !== undefined) {
      const replay = await this.replay(this.db, organizationId, action, idempotencyKey, input);
      if (replay !== null) return replay;
    }
    const employee = await loadEmployeeByMember(this.db, organizationId, action.principal.memberId);
    if (employee === null || !canRecordAttendance(employee)) throw new AttendanceError('ATTENDANCE_NOT_ELIGIBLE');
    try {
      return await this.db.$transaction(async (tx) => {
        const now = this.clock();
        const timeZone = await attendanceZone(tx, organizationId, employee);
        const today = localToday(now, timeZone);
        if (input.workDate > today) throw new InvalidInputError('workDate', 'A future day cannot be corrected.');
        if (input.workDate < addDays(today, -CORRECTION_MAX_DAYS_BACK)) {
          throw new InvalidInputError(
            'workDate',
            `Corrections are limited to the last ${String(CORRECTION_MAX_DAYS_BACK)} days. Contact HR.`,
          );
        }
        await lockAttendanceProfile(tx, organizationId, employee.id);
        const type = await ensureCorrectionType(tx, organizationId, 'on-demand');
        if (!type.active)
          throw new InvalidTransitionError('Attendance corrections are currently disabled. Contact HR.');
        const pending = await tx.attendanceAdjustmentRequest.findFirst({
          where: {
            organizationId,
            profileId: employee.id,
            workDate: fromDateOnly(input.workDate),
            appliedAt: null,
            request: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'IN_FULFILLMENT'] } },
          },
          select: { id: true },
        });
        if (pending !== null) {
          throw new ConflictError('A correction for this day is already pending.');
        }
        const record = await findRecord(tx, organizationId, employee.id, input.workDate);
        const times = correctedTimes(input.workDate, timeZone, input, record, now);
        const requestId = await this.requests.createReservedInTx(tx, action, type.id, {
          workDate: input.workDate,
          reasonCode: correctionReasonOption(input.reasonCode),
          ...(input.checkIn === undefined ? {} : { checkIn: input.checkIn }),
          ...(input.checkOut === undefined ? {} : { checkOut: input.checkOut }),
          ...(input.checkOutNextDay === undefined ? {} : { checkOutNextDay: input.checkOutNextDay }),
          details: input.details,
        });
        const created = await tx.attendanceAdjustmentRequest.create({
          data: {
            organizationId,
            profileId: employee.id,
            requesterMemberId: action.principal.memberId,
            recordId: record?.id ?? null,
            workDate: fromDateOnly(input.workDate),
            reasonCode: input.reasonCode,
            requestedCheckInAt: times.checkInAt,
            requestedCheckOutAt: times.checkOutAt,
            originalCheckInAt: record?.checkInAt ?? null,
            originalCheckOutAt: record?.checkOutAt ?? null,
            details: input.details,
            requestId,
            idempotencyKey: idempotencyKey ?? null,
          },
          select: correctionSelect,
        });
        return toCorrectionView(created);
      });
    } catch (error) {
      if (idempotencyKey !== undefined && isUniqueViolation(error)) {
        const replay = await this.replay(this.db, organizationId, action, idempotencyKey, input);
        if (replay !== null) return replay;
      }
      throw error;
    }
  }

  async listMine(
    action: ActionContext,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<CorrectionView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.self');
    const size = pageSize(query.limit);
    const and: Prisma.AttendanceAdjustmentRequestWhereInput[] = [];
    if (query.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(query.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) throw new InvalidInputError('cursor', 'The cursor is invalid.');
      and.push({ OR: [{ createdAt: { lt: key } }, { createdAt: key, id: { lt: id } }] });
    }
    const rows = await this.db.attendanceAdjustmentRequest.findMany({
      where: { organizationId, requesterMemberId: action.principal.memberId, AND: and },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: correctionSelect,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map(toCorrectionView), nextCursor: page.nextCursor };
  }

  /**
   * Direct correction by an administrator: appends an `ADJUSTED` event with the administrator as actor,
   * re-derives the record (created with its shift snapshot when the day has none) and audits it.
   */
  async adminCorrect(action: ActionContext, input: AdminCorrectionInput): Promise<RecordDetailView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'attendance.admin')) throw new ForbiddenError();
    const recordId = await this.db.$transaction(async (tx) => {
      const now = this.clock();
      const employee = await loadEmployeeByProfile(tx, organizationId, input.profileId);
      if (employee === null) throw new NotFoundError('Employee');
      if (employee.memberId === action.principal.memberId) {
        throw new ForbiddenError('Administrators cannot correct their own attendance.');
      }
      const timeZone = await attendanceZone(tx, organizationId, employee);
      const today = localToday(now, timeZone);
      if (input.workDate > today) throw new InvalidInputError('workDate', 'A future day cannot be corrected.');
      if (input.workDate < addDays(today, -ADMIN_MAX_DAYS_BACK)) {
        throw new InvalidInputError('workDate', 'The day is too far in the past.');
      }
      await lockAttendanceProfile(tx, organizationId, employee.id);
      const existing = await findRecord(tx, organizationId, employee.id, input.workDate);
      if (
        (existing === null) !== (input.version === null) ||
        (existing !== null && existing.version !== input.version)
      ) {
        throw new VersionConflictError('Attendance record');
      }
      const record = existing ?? (await this.createRecord(tx, organizationId, employee, input.workDate, timeZone));
      const times = correctedTimes(input.workDate, timeZone, input, record, now);
      await tx.attendanceEvent.create({
        data: {
          organizationId,
          recordId: record.id,
          profileId: employee.id,
          kind: 'ADJUSTED',
          recordedAt: now,
          workDate: fromDateOnly(input.workDate),
          mode: record.mode ?? 'OFFICE',
          actorMemberId: action.principal.memberId,
          reasonCode: input.reasonCode,
          note: input.note,
          previousCheckInAt: record.checkInAt,
          previousCheckOutAt: record.checkOutAt,
          adjustedCheckInAt: times.checkInAt,
          adjustedCheckOutAt: times.checkOutAt,
          idempotencyKey: `admin:${record.id}:${String(record.version)}`,
        },
        select: { id: true },
      });
      const updated = await rederiveRecord(tx, organizationId, record.id, now);
      await recordAudit(tx, organizationId, {
        action: 'attendance.record.corrected',
        entityType: 'attendance_record',
        entityId: record.id,
        actor: userActor(action),
        metadata: {
          profileId: employee.id,
          workDate: input.workDate,
          reasonCode: input.reasonCode,
          before: {
            checkInAt: record.checkInAt?.toISOString() ?? null,
            checkOutAt: record.checkOutAt?.toISOString() ?? null,
          },
          after: {
            checkInAt: updated.checkInAt?.toISOString() ?? null,
            checkOutAt: updated.checkOutAt?.toISOString() ?? null,
          },
        },
        context: action.request,
      });
      await announceAttendanceChange(tx, organizationId, record.id);
      return record.id;
    });
    return this.attendance.recordDetail(action, recordId);
  }

  // ---- internals ----

  private async createRecord(
    tx: TenantDb,
    organizationId: string,
    employee: { id: string; memberId: string },
    workDate: string,
    timeZone: string,
  ): Promise<RecordRow> {
    const lookup = runningShifts(await assignedShifts(tx, organizationId, employee.id, workDate, workDate));
    return ensureRecord(tx, organizationId, employee, workDate, timeZone, lookup(workDate));
  }

  private async replay(
    db: TenantDb,
    organizationId: string,
    action: ActionContext,
    idempotencyKey: string,
    input: CreateCorrectionInput,
  ): Promise<CorrectionView | null> {
    const existing = await db.attendanceAdjustmentRequest.findFirst({
      where: { organizationId, requesterMemberId: action.principal.memberId, idempotencyKey },
      select: correctionSelect,
    });
    if (existing === null) return null;
    if (toDateOnly(existing.workDate) !== input.workDate || existing.reasonCode !== input.reasonCode) {
      throw new ConflictError('The Idempotency-Key was already used for a different request.');
    }
    return toCorrectionView(existing);
  }
}
