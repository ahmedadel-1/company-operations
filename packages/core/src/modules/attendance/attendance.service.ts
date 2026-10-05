import type { Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { csvCell } from '../../platform/csv.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { lockAttendanceProfile } from '../../platform/db/sql/attendance.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
} from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { assertPermission, isEmptyListScope } from '../authorization/policy.js';
import { addDays, daysBetween, fromDateOnly, localToday, toDateOnly } from '../projects/business-date.js';
import {
  accessTo,
  canReview,
  employeeFacts,
  isAttendanceAdmin,
  profileScopeWhere,
  teamScope,
} from './attendance-access.js';
import { AttendanceError } from './attendance-errors.js';
import {
  assignedShifts,
  assignedShiftsOf,
  attendanceZone,
  canRecordAttendance,
  announceAttendanceChange,
  DEFAULT_MISSING_CHECKOUT_MINUTES,
  effectsOn,
  eligibleLocations,
  ensureRecord,
  eventViewSelect,
  findRecord,
  loadEmployeeByMember,
  loadPolicy,
  organizationZone,
  recordedEffects,
  recordedEffectsOf,
  recordSnapshot,
  recordViewSelect,
  rederiveRecord,
  runningShifts,
  shiftRefView,
  toEmployeeRef,
  toEventView,
  toRecordView,
  boundedRange,
} from './attendance-store.js';
import type {
  AttendanceEventView,
  AttendanceRecordView,
  EffectRow,
  EmployeeRefView,
  EmployeeRow,
  PolicyRow,
  RecordRow,
} from './attendance-store.js';
import { DAY_BUCKETS, dayBuckets, dayStatus } from './engine/derive.js';
import type { AttendanceMode, DayBucket, DayStatus } from './engine/derive.js';
import { evaluateGeofence, roundCoordinate } from './engine/geofence.js';
import { formatMinutes, missingCheckoutDeadline, resolveWorkDate, scheduleFor, shiftRunsOn } from './engine/time.js';

export type CheckKind = 'CHECK_IN' | 'CHECK_OUT';

export type LocationInput =
  | { readonly status: 'OK'; readonly latitude: number; readonly longitude: number; readonly accuracy: number }
  | { readonly status: 'PERMISSION_DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED' };

export interface CheckInput {
  readonly location?: LocationInput | undefined;
}

export interface CheckResultView {
  readonly record: AttendanceRecordView;
  readonly event: AttendanceEventView;
  readonly replayed: boolean;
}

export interface EffectRefView {
  readonly mode: EffectRow['mode'];
  readonly requestId: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly fromTime: string | null;
  readonly toTime: string | null;
}

export interface TodayView {
  readonly serverTime: string;
  readonly workDate: string;
  readonly timeZone: string;
  readonly eligible: boolean;
  readonly ineligibleReason: 'NO_PROFILE' | 'NOT_ACTIVE' | null;
  readonly configured: boolean;
  readonly locationRequired: boolean;
  readonly plannedMode: AttendanceMode | null;
  readonly shift: ReturnType<typeof shiftRefView> | null;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly record: AttendanceRecordView | null;
  readonly nextAction: 'CHECK_IN' | 'CHECK_OUT' | 'NONE';
  readonly effects: readonly EffectRefView[];
  readonly maxAccuracyMeters: number | null;
  readonly eligibleLocationCount: number;
}

export interface RecordDetailView {
  readonly record: AttendanceRecordView;
  readonly events: readonly AttendanceEventView[];
  readonly canReview: boolean;
  readonly canCorrect: boolean;
}

export interface TeamDayView {
  readonly employee: EmployeeRefView;
  readonly date: string;
  readonly status: DayStatus;
  readonly plannedMode: AttendanceMode | null;
  readonly record: AttendanceRecordView | null;
}

export interface ReviewItemView {
  readonly event: AttendanceEventView;
  readonly record: AttendanceRecordView;
}

export interface RecordFilter {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly status?: readonly RecordRow['status'][] | undefined;
  readonly departmentId?: string | undefined;
  readonly profileId?: string | undefined;
  readonly needsReview?: boolean | undefined;
  readonly late?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface TeamDaySummary {
  readonly date: string;
  readonly timeZone: string;
  readonly employees: number;
  readonly counts: Readonly<Record<DayBucket, number>>;
  readonly truncated: boolean;
}

const teamProfileSelect = {
  id: true,
  memberId: true,
  fullName: true,
  employeeNumber: true,
  timeZone: true,
  department: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeProfileSelect;
type TeamProfileRow = Prisma.EmployeeProfileGetPayload<{ select: typeof teamProfileSelect }>;

/** Profiles derived per query batch, and the most a bucket filter or summary evaluates. */
const TEAM_DAY_CHUNK = 500;
export const TEAM_DAY_SCAN_MAX = 5000;

export const MAX_RANGE_DAYS = 62;
export const MAX_EXPORT_ROWS = 10_000;
const USER_AGENT_MAX = 512;

const effectRef = (effect: EffectRow): EffectRefView => ({
  mode: effect.mode,
  requestId: effect.requestId,
  startsOn: effect.startsOn,
  endsOn: effect.endsOn,
  fromTime: effect.startsAtMinute === null ? null : formatMinutes(effect.startsAtMinute),
  toTime: effect.endsAtMinute === null ? null : formatMinutes(effect.endsAtMinute),
});

function plannedModeFor(effects: readonly EffectRow[]): AttendanceMode | null {
  if (effects.some((effect) => effect.mode === 'LEAVE')) return 'LEAVE';
  if (effects.some((effect) => effect.mode === 'BUSINESS_MISSION')) return 'BUSINESS_MISSION';
  if (effects.some((effect) => effect.mode === 'REMOTE')) return 'REMOTE';
  return null;
}

function localClock(instant: Date | null, timeZone: string): string {
  if (instant === null) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    instant,
  );
}

/**
 * Attendance for employees, managers and HR (ADR-0022): Today, check-in/out with server-side geofencing
 * and idempotency, history, team views, record detail, low-accuracy reviews and a bounded export.
 */
export class AttendanceService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---- Employee ----

  async today(action: ActionContext): Promise<TodayView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.self');
    const now = this.clock();
    const employee = await loadEmployeeByMember(this.db, organizationId, action.principal.memberId);
    const timeZone =
      employee === null
        ? await organizationZone(this.db, organizationId)
        : await attendanceZone(this.db, organizationId, employee);
    const policy = await loadPolicy(this.db, organizationId);
    const base = {
      serverTime: now.toISOString(),
      timeZone,
      configured: policy !== null,
      maxAccuracyMeters: policy?.maxAccuracyMeters ?? null,
    };
    if (employee === null || !canRecordAttendance(employee)) {
      return {
        ...base,
        workDate: localToday(now, timeZone),
        eligible: false,
        ineligibleReason: employee === null ? 'NO_PROFILE' : 'NOT_ACTIVE',
        locationRequired: false,
        plannedMode: null,
        shift: null,
        scheduledStartAt: null,
        scheduledEndAt: null,
        record: null,
        nextAction: 'NONE',
        effects: [],
        eligibleLocationCount: 0,
      };
    }
    const context = await this.dayContext(this.db, organizationId, employee, timeZone, policy, now);
    const open = await this.openRecord(this.db, organizationId, employee, timeZone, policy, now);
    const record = open ?? (await findRecord(this.db, organizationId, employee.id, context.workDate));
    const workDate = record === null ? context.workDate : (toDateOnly(record.workDate) ?? context.workDate);
    const effects =
      record === null || workDate === context.workDate
        ? context.effects
        : await this.effectsFor(organizationId, employee.memberId, workDate);
    const planned = record?.mode ?? plannedModeFor(effects);
    const snapshot = record === null ? context.shift : recordSnapshot(record);
    const recordedStart = record?.scheduledStartAt ?? null;
    const recordedEnd = record?.scheduledEndAt ?? null;
    const schedule =
      recordedStart !== null && recordedEnd !== null
        ? { start: recordedStart, end: recordedEnd }
        : snapshot === null
          ? null
          : scheduleFor(snapshot, workDate, timeZone);
    let nextAction: TodayView['nextAction'] = 'NONE';
    if (record !== null && record.checkInAt !== null) {
      nextAction = record.checkOutAt === null && record.status === 'OPEN' ? 'CHECK_OUT' : 'NONE';
    } else if (planned !== 'LEAVE') {
      nextAction = 'CHECK_IN';
    }
    const locationRequired = planned === null || planned === 'OFFICE' || planned === 'SITE';
    return {
      ...base,
      workDate,
      eligible: true,
      ineligibleReason: null,
      locationRequired: nextAction !== 'NONE' && locationRequired,
      plannedMode: planned,
      shift: snapshot === null ? null : shiftRefView(snapshot),
      scheduledStartAt: schedule?.start.toISOString() ?? null,
      scheduledEndAt: schedule?.end.toISOString() ?? null,
      record: record === null ? null : toRecordView(record),
      nextAction,
      effects: effects.map(effectRef),
      eligibleLocationCount: (await eligibleLocations(this.db, organizationId, employee.id, workDate)).length,
    };
  }

  /**
   * Check-in or check-out (ADR-0022). The server decides the work day, the time, the matched location,
   * the distance and the result; an `Idempotency-Key` replay by the same member returns the original
   * outcome without a new event.
   */
  async check(
    action: ActionContext,
    kind: CheckKind,
    input: CheckInput,
    idempotencyKey: string,
  ): Promise<CheckResultView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.self');
    const replay = await this.replay(this.db, organizationId, action, kind, idempotencyKey);
    if (replay !== null) return replay;
    const employee = await loadEmployeeByMember(this.db, organizationId, action.principal.memberId);
    if (employee === null || !canRecordAttendance(employee)) {
      throw new AttendanceError('ATTENDANCE_NOT_ELIGIBLE');
    }
    try {
      return await this.db.$transaction(async (tx) => {
        await lockAttendanceProfile(tx, organizationId, employee.id);
        const again = await this.replay(tx, organizationId, action, kind, idempotencyKey);
        if (again !== null) return again;
        const now = this.clock();
        const timeZone = await attendanceZone(tx, organizationId, employee);
        const policy = await loadPolicy(tx, organizationId);
        let record: RecordRow;
        let mode: AttendanceMode;
        let workDate: string;
        if (kind === 'CHECK_IN') {
          const context = await this.dayContext(tx, organizationId, employee, timeZone, policy, now);
          workDate = context.workDate;
          const existing = await findRecord(tx, organizationId, employee.id, workDate);
          if (existing !== null && existing.checkInAt !== null) {
            throw new AttendanceError(
              existing.checkOutAt === null ? 'ATTENDANCE_ALREADY_CHECKED_IN' : 'ATTENDANCE_ALREADY_CHECKED_OUT',
            );
          }
          const planned = plannedModeFor(context.effects);
          if (planned === 'LEAVE') throw new AttendanceError('ATTENDANCE_ON_LEAVE');
          mode = planned ?? 'OFFICE';
          record = existing ?? (await ensureRecord(tx, organizationId, employee, workDate, timeZone, context.shift));
        } else {
          const open = await this.openRecord(tx, organizationId, employee, timeZone, policy, now);
          if (open === null) {
            const context = await this.dayContext(tx, organizationId, employee, timeZone, policy, now);
            const current = await findRecord(tx, organizationId, employee.id, context.workDate);
            throw new AttendanceError(
              current !== null && current.checkOutAt !== null
                ? 'ATTENDANCE_ALREADY_CHECKED_OUT'
                : 'ATTENDANCE_NOT_CHECKED_IN',
            );
          }
          record = open;
          workDate = toDateOnly(open.workDate) ?? '';
          mode = open.mode ?? 'OFFICE';
        }
        const evidence = await this.evidence(tx, organizationId, employee, workDate, mode, policy, input.location);
        const eventMode: AttendanceMode =
          mode === 'REMOTE' || mode === 'BUSINESS_MISSION'
            ? mode
            : kind === 'CHECK_OUT'
              ? mode
              : evidence.locationType === null || evidence.locationType === 'OFFICE'
                ? 'OFFICE'
                : 'SITE';
        const created = await tx.attendanceEvent.create({
          data: {
            organizationId,
            recordId: record.id,
            profileId: employee.id,
            kind,
            recordedAt: now,
            effectiveAt: now,
            workDate: fromDateOnly(workDate),
            mode: eventMode,
            workLocationId: evidence.locationId,
            latitude: evidence.latitude,
            longitude: evidence.longitude,
            accuracyMeters: evidence.accuracyMeters,
            distanceMeters: evidence.distanceMeters,
            allowedRadiusMeters: evidence.allowedRadiusMeters,
            accuracyThresholdMeters: evidence.accuracyThresholdMeters,
            geofenceResult: evidence.result,
            reviewStatus: evidence.review ? 'PENDING_REVIEW' : 'NOT_REQUIRED',
            actorMemberId: action.principal.memberId,
            ipAddress: action.request?.ip?.slice(0, 64) ?? null,
            userAgent: action.request?.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
            idempotencyKey,
            keyOwnerMemberId: action.principal.memberId,
          },
          select: { id: true },
        });
        const updated = await rederiveRecord(tx, organizationId, record.id, now);
        await announceAttendanceChange(tx, organizationId, record.id);
        const event = await tx.attendanceEvent.findFirstOrThrow({
          where: { organizationId, id: created.id },
          select: eventViewSelect,
        });
        return { record: toRecordView(updated), event: toEventView(event, false), replayed: false };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replayed = await this.replay(this.db, organizationId, action, kind, idempotencyKey);
        if (replayed !== null) return replayed;
        throw new ConflictError('The Idempotency-Key was already used for a different request.');
      }
      throw error;
    }
  }

  async myRecords(action: ActionContext, filter: RecordFilter): Promise<Page<AttendanceRecordView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.self');
    return this.pageRecords(
      organizationId,
      [{ memberId: action.principal.memberId }],
      filter,
      await organizationZone(this.db, organizationId),
    );
  }

  // ---- Team / HR ----

  async records(action: ActionContext, filter: RecordFilter): Promise<Page<AttendanceRecordView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.team');
    const today = localToday(this.clock(), await organizationZone(this.db, organizationId));
    const profileWhere = this.scopeWhere(action, today);
    if (profileWhere === null) return { items: [], nextCursor: null };
    return this.pageRecords(
      organizationId,
      [{ profile: profileWhere }],
      filter,
      await organizationZone(this.db, organizationId),
    );
  }

  /**
   * Everyone in scope on one date with a derived status (records where they exist), by name. With a
   * `bucket`, only employees in that dashboard bucket (ADR-0023): profiles are scanned in name order in
   * bounded chunks until the page is full, so the list and the dashboard count apply the same rule.
   */
  async teamDay(
    action: ActionContext,
    query: {
      date?: string | undefined;
      departmentId?: string | undefined;
      bucket?: DayBucket | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<Page<TeamDayView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.team');
    const now = this.clock();
    const orgZone = await organizationZone(this.db, organizationId);
    const today = localToday(now, orgZone);
    const date = query.date ?? today;
    const profileWhere = this.scopeWhere(action, today);
    if (profileWhere === null) return { items: [], nextCursor: null };
    const size = pageSize(query.limit);
    const base: Prisma.EmployeeProfileWhereInput[] = [profileWhere, { employmentStatus: { not: 'TERMINATED' } }];
    if (query.departmentId !== undefined) base.push({ departmentId: query.departmentId });
    let after: { name: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      const [name = '', id = ''] = decodeCursor(query.cursor, 2);
      after = { name, id };
    }
    const bucket = query.bucket;
    if (bucket === undefined) {
      const profiles = await this.teamProfiles(organizationId, base, after, size + 1);
      const page = toPage(profiles, size, (row) => [row.fullName, row.id]);
      const items = await this.deriveDay(organizationId, orgZone, now, date, page.items);
      return { items, nextCursor: page.nextCursor };
    }
    const matches: TeamDayView[] = [];
    let scanned = 0;
    while (matches.length <= size && scanned < TEAM_DAY_SCAN_MAX) {
      const chunk = await this.teamProfiles(organizationId, base, after, TEAM_DAY_CHUNK);
      if (chunk.length === 0) break;
      scanned += chunk.length;
      const derived = await this.deriveDay(organizationId, orgZone, now, date, chunk);
      matches.push(...derived.filter((item) => dayBuckets(item.status, item.record).includes(bucket)));
      const last = chunk.at(-1);
      if (last === undefined || chunk.length < TEAM_DAY_CHUNK) break;
      after = { name: last.fullName, id: last.id };
    }
    const page = toPage(matches.slice(0, size + 1), size, (item) => [item.employee.fullName, item.employee.profileId]);
    return { items: page.items, nextCursor: page.nextCursor };
  }

  /**
   * Bucket counts for everyone in scope on the organization's current date (dashboard, ADR-0023).
   * Evaluates at most {@link TEAM_DAY_SCAN_MAX} employees by name; `truncated` says when more exist.
   */
  async teamDaySummary(action: ActionContext): Promise<TeamDaySummary> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.team');
    const now = this.clock();
    const orgZone = await organizationZone(this.db, organizationId);
    const date = localToday(now, orgZone);
    const counts = Object.fromEntries(DAY_BUCKETS.map((bucket) => [bucket, 0])) as Record<DayBucket, number>;
    const summary = { date, timeZone: orgZone, employees: 0, counts, truncated: false };
    const profileWhere = this.scopeWhere(action, date);
    if (profileWhere === null) return summary;
    const base: Prisma.EmployeeProfileWhereInput[] = [profileWhere, { employmentStatus: { not: 'TERMINATED' } }];
    let after: { name: string; id: string } | null = null;
    while (summary.employees < TEAM_DAY_SCAN_MAX) {
      const chunk = await this.teamProfiles(organizationId, base, after, TEAM_DAY_CHUNK);
      if (chunk.length === 0) break;
      summary.employees += chunk.length;
      for (const item of await this.deriveDay(organizationId, orgZone, now, date, chunk)) {
        for (const bucket of dayBuckets(item.status, item.record)) counts[bucket] += 1;
      }
      const last = chunk.at(-1);
      if (last === undefined || chunk.length < TEAM_DAY_CHUNK) break;
      after = { name: last.fullName, id: last.id };
      if (summary.employees >= TEAM_DAY_SCAN_MAX) {
        summary.truncated = (await this.teamProfiles(organizationId, base, after, 1)).length > 0;
      }
    }
    return summary;
  }

  /**
   * Employees in the caller's `attendance.team` scope who checked in, per work date in `[from, to]`
   * (stored records only; dashboard trend). One grouped query.
   */
  async presenceByDate(action: ActionContext, from: string, to: string): Promise<Map<string, number>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.team');
    const today = localToday(this.clock(), await organizationZone(this.db, organizationId));
    const profileWhere = this.scopeWhere(action, today);
    if (profileWhere === null) return new Map();
    const rows = await this.db.attendanceRecord.groupBy({
      by: ['workDate'],
      where: {
        organizationId,
        AND: [
          { profile: profileWhere },
          { workDate: { gte: fromDateOnly(from), lte: fromDateOnly(to) } },
          { checkInAt: { not: null } },
        ],
      },
      _count: { _all: true },
    });
    return new Map(rows.map((row) => [toDateOnly(row.workDate) ?? '', row._count._all]));
  }

  /**
   * How many events {@link reviews} would list and when the oldest was recorded (dashboard count);
   * null without review rights.
   */
  async pendingReviewSummary(action: ActionContext): Promise<{ count: number; oldestAt: Date | null } | null> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const admin = isAttendanceAdmin(action);
    if (!admin && !hasPermission(action.principal.permissions, 'attendance.team')) return null;
    const today = localToday(this.clock(), await organizationZone(this.db, organizationId));
    const profileWhere = admin ? {} : this.scopeWhere(action, today);
    if (profileWhere === null) return { count: 0, oldestAt: null };
    const where: Prisma.AttendanceEventWhereInput = {
      organizationId,
      AND: [
        { reviewStatus: 'PENDING_REVIEW' },
        { profile: { AND: [profileWhere, { memberId: { not: action.principal.memberId } }] } },
      ],
    };
    const count = await this.db.attendanceEvent.count({ where });
    if (count === 0) return { count, oldestAt: null };
    const oldest = await this.db.attendanceEvent.findFirst({
      where,
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      select: { recordedAt: true },
    });
    return { count, oldestAt: oldest?.recordedAt ?? null };
  }

  async recordDetail(action: ActionContext, recordId: string): Promise<RecordDetailView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const { record, facts } = await this.visibleRecord(this.db, action, organizationId, recordId);
    const events = await this.db.attendanceEvent.findMany({
      where: { organizationId, recordId },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: eventViewSelect,
    });
    const admin = isAttendanceAdmin(action);
    return {
      record: toRecordView(record),
      events: events.map((event) => toEventView(event, admin)),
      canReview: canReview(action, facts) && events.some((event) => event.reviewStatus === 'PENDING_REVIEW'),
      canCorrect: admin,
    };
  }

  /** Events awaiting review that the caller may decide (never their own). */
  async reviews(
    action: ActionContext,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<ReviewItemView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!isAttendanceAdmin(action)) assertPermission(action.principal, 'attendance.team');
    const today = localToday(this.clock(), await organizationZone(this.db, organizationId));
    const profileWhere = isAttendanceAdmin(action) ? {} : this.scopeWhere(action, today);
    if (profileWhere === null) return { items: [], nextCursor: null };
    const size = pageSize(query.limit);
    const and: Prisma.AttendanceEventWhereInput[] = [
      { reviewStatus: 'PENDING_REVIEW' },
      { profile: { AND: [profileWhere, { memberId: { not: action.principal.memberId } }] } },
    ];
    if (query.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(query.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) throw new InvalidInputError('cursor', 'The cursor is invalid.');
      and.push({ OR: [{ recordedAt: { gt: key } }, { recordedAt: key, id: { gt: id } }] });
    }
    const rows = await this.db.attendanceEvent.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      take: size + 1,
      select: { ...eventViewSelect, record: { select: recordViewSelect } },
    });
    const page = toPage(rows, size, (row) => [row.recordedAt.toISOString(), row.id]);
    const admin = isAttendanceAdmin(action);
    return {
      items: page.items.map((row) => ({ event: toEventView(row, admin), record: toRecordView(row.record) })),
      nextCursor: page.nextCursor,
    };
  }

  /** Decides a pending review once (ACCEPTED / REJECTED); the event itself is never rewritten. */
  async review(
    action: ActionContext,
    eventId: string,
    decision: 'ACCEPTED' | 'REJECTED',
    note: string | undefined,
  ): Promise<RecordDetailView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const recordId = await this.db.$transaction(async (tx) => {
      const event = await tx.attendanceEvent.findFirst({
        where: { organizationId, id: eventId },
        select: {
          id: true,
          recordId: true,
          profileId: true,
          reviewStatus: true,
          workDate: true,
          profile: { select: { memberId: true } },
        },
      });
      if (event === null) throw new NotFoundError('Attendance event');
      const now = this.clock();
      const today = localToday(now, await organizationZone(tx, organizationId));
      const facts = await employeeFacts(tx, organizationId, event.profileId, today);
      if (facts === null || accessTo(action, facts) === 'NONE') throw new NotFoundError('Attendance event');
      if (!canReview(action, facts)) throw new ForbiddenError();
      if (decision === 'REJECTED' && note === undefined) {
        throw new InvalidInputError('note', 'A note is required when evidence is rejected.');
      }
      await lockAttendanceProfile(tx, organizationId, event.profileId);
      const updated = await tx.attendanceEvent.updateMany({
        where: { organizationId, id: eventId, reviewStatus: 'PENDING_REVIEW' },
        data: {
          reviewStatus: decision,
          reviewedByMemberId: action.principal.memberId,
          reviewedAt: now,
          reviewNote: note ?? null,
        },
      });
      if (updated.count === 0) throw new InvalidTransitionError('This evidence was already reviewed.');
      await rederiveRecord(tx, organizationId, event.recordId, now);
      await announceAttendanceChange(tx, organizationId, event.recordId);
      await recordAudit(tx, organizationId, {
        action: 'attendance.review.decided',
        entityType: 'attendance_event',
        entityId: eventId,
        actor: userActor(action),
        metadata: { recordId: event.recordId, decision, workDate: toDateOnly(event.workDate) },
        context: action.request,
      });
      await enqueueOutboxEvent(tx, organizationId, {
        eventType: 'notification.requested',
        aggregateType: 'attendance_record',
        aggregateId: event.recordId,
        payload: {
          recipientMemberId: event.profile.memberId,
          type: 'ATTENDANCE_REVIEW_DECIDED',
          severity: decision === 'REJECTED' ? 'WARNING' : 'INFO',
          entityType: 'attendance_record',
          entityId: event.recordId,
          params: { date: toDateOnly(event.workDate) ?? '', decision },
          dedupeKey: `attendance-review:${eventId}`,
        },
      });
      return event.recordId;
    });
    return this.recordDetail(action, recordId);
  }

  /** CSV of records in scope (no coordinates), at most 62 days and 10 000 rows; audited. */
  async exportCsv(
    action: ActionContext,
    filter: Omit<RecordFilter, 'cursor' | 'limit' | 'needsReview' | 'late'> & { from: string; to: string },
  ): Promise<{ filename: string; csv: string; rows: number }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'attendance.team');
    if (filter.from > filter.to || daysBetween(filter.from, filter.to) >= MAX_RANGE_DAYS) {
      throw new InvalidInputError('to', `The export range must be at most ${String(MAX_RANGE_DAYS)} days.`);
    }
    const today = localToday(this.clock(), await organizationZone(this.db, organizationId));
    const profileWhere = this.scopeWhere(action, today);
    const and: Prisma.AttendanceRecordWhereInput[] = [
      { workDate: { gte: fromDateOnly(filter.from), lte: fromDateOnly(filter.to) } },
      { profile: profileWhere ?? {} },
    ];
    if (filter.status !== undefined && filter.status.length > 0) and.push({ status: { in: [...filter.status] } });
    if (filter.profileId !== undefined) and.push({ profileId: filter.profileId });
    if (filter.departmentId !== undefined) and.push({ profile: { departmentId: filter.departmentId } });
    const rows =
      profileWhere === null
        ? []
        : await this.db.attendanceRecord.findMany({
            where: { organizationId, AND: and },
            orderBy: [{ workDate: 'asc' }, { profileId: 'asc' }],
            take: MAX_EXPORT_ROWS + 1,
            select: recordViewSelect,
          });
    if (rows.length > MAX_EXPORT_ROWS) {
      throw new InvalidInputError(
        'to',
        `The export is limited to ${String(MAX_EXPORT_ROWS)} rows. Narrow the filters.`,
      );
    }
    const header = [
      'employee_number',
      'employee',
      'department',
      'work_date',
      'status',
      'mode',
      'shift',
      'scheduled_start',
      'scheduled_end',
      'check_in',
      'check_out',
      'check_in_location',
      'late_minutes',
      'early_leave_minutes',
      'worked_minutes',
      'needs_review',
      'adjusted',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.profile.employeeNumber,
          row.profile.fullName,
          row.profile.department?.name ?? null,
          toDateOnly(row.workDate),
          row.status,
          row.mode,
          row.shiftName,
          localClock(row.scheduledStartAt, row.timeZone),
          localClock(row.scheduledEndAt, row.timeZone),
          localClock(row.checkInAt, row.timeZone),
          localClock(row.checkOutAt, row.timeZone),
          row.checkInLocation?.name ?? null,
          row.lateMinutes,
          row.earlyLeaveMinutes,
          row.workedMinutes,
          row.needsReview ? 'yes' : 'no',
          row.adjusted ? 'yes' : 'no',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    await recordAudit(this.db, organizationId, {
      action: 'attendance.exported',
      entityType: 'attendance_record',
      entityId: null,
      actor: userActor(action),
      metadata: {
        from: filter.from,
        to: filter.to,
        rows: rows.length,
        status: filter.status === undefined ? null : [...filter.status],
        departmentId: filter.departmentId ?? null,
        profileId: filter.profileId ?? null,
      },
      context: action.request,
    });
    return {
      filename: `attendance-${filter.from}-${filter.to}.csv`,
      csv: `${lines.join('\r\n')}\r\n`,
      rows: rows.length,
    };
  }

  // ---- internals ----

  private teamProfiles(
    organizationId: string,
    base: readonly Prisma.EmployeeProfileWhereInput[],
    after: { readonly name: string; readonly id: string } | null,
    take: number,
  ) {
    const and = [...base];
    if (after !== null) {
      and.push({ OR: [{ fullName: { gt: after.name } }, { fullName: after.name, id: { gt: after.id } }] });
    }
    return this.db.employeeProfile.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take,
      select: teamProfileSelect,
    });
  }

  /** Derived day status for a batch of profiles: four queries regardless of the batch size. */
  private async deriveDay(
    organizationId: string,
    orgZone: string,
    now: Date,
    date: string,
    profiles: readonly TeamProfileRow[],
  ): Promise<TeamDayView[]> {
    if (profiles.length === 0) return [];
    const records = await this.db.attendanceRecord.findMany({
      where: { organizationId, workDate: fromDateOnly(date), profileId: { in: profiles.map((row) => row.id) } },
      select: recordViewSelect,
    });
    const byProfile = new Map(records.map((row) => [row.profileId, row]));
    const effectsOf = await recordedEffectsOf(
      this.db,
      organizationId,
      profiles.map((row) => row.memberId),
      date,
      date,
    );
    const shiftsOf = await assignedShiftsOf(
      this.db,
      organizationId,
      profiles.map((row) => row.id),
      date,
      date,
    );
    return profiles.map((profile) => {
      const zone = profile.timeZone ?? orgZone;
      const record = byProfile.get(profile.id) ?? null;
      const effects = effectsOf(profile.memberId);
      const shift = shiftsOf(profile.id)(date);
      const scheduledEnd =
        record?.scheduledEndAt ??
        (shift !== null && shiftRunsOn(shift, date) ? scheduleFor(shift, date, zone).end : null);
      return {
        employee: toEmployeeRef(profile),
        date,
        status: dayStatus({
          date,
          today: localToday(now, zone),
          now,
          record,
          effects: effectsOn(effects, date),
          shift: shift === null ? null : { runsThatDay: shiftRunsOn(shift, date), scheduledEnd },
        }),
        plannedMode: record?.mode ?? plannedModeFor(effects),
        record: record === null ? null : toRecordView(record),
      };
    });
  }

  private scopeWhere(action: ActionContext, today: string): Prisma.EmployeeProfileWhereInput | null {
    const scope = teamScope(action);
    if (isEmptyListScope(scope)) return null;
    return profileScopeWhere(scope, today);
  }

  private async pageRecords(
    organizationId: string,
    scope: Prisma.AttendanceRecordWhereInput[],
    filter: RecordFilter,
    timeZone: string,
  ): Promise<Page<AttendanceRecordView>> {
    const size = pageSize(filter.limit);
    const range = boundedRange(filter.from, filter.to, localToday(this.clock(), timeZone), 366);
    if (range === null) throw new InvalidInputError('from', 'The date range is invalid (at most one year).');
    const and: Prisma.AttendanceRecordWhereInput[] = [
      ...scope,
      { workDate: { gte: fromDateOnly(range.from), lte: fromDateOnly(range.to) } },
    ];
    if (filter.status !== undefined && filter.status.length > 0) and.push({ status: { in: [...filter.status] } });
    if (filter.departmentId !== undefined) and.push({ profile: { departmentId: filter.departmentId } });
    if (filter.profileId !== undefined) and.push({ profileId: filter.profileId });
    if (filter.needsReview !== undefined) and.push({ needsReview: filter.needsReview });
    if (filter.late === true) and.push({ lateMinutes: { gt: 0 } });
    if (filter.late === false) and.push({ lateMinutes: 0 });
    if (filter.cursor !== undefined) {
      const [date = '', id = ''] = decodeCursor(filter.cursor, 2);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new InvalidInputError('cursor', 'The cursor is invalid.');
      const key = fromDateOnly(date);
      and.push({ OR: [{ workDate: { lt: key } }, { workDate: key, id: { lt: id } }] });
    }
    const rows = await this.db.attendanceRecord.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ workDate: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: recordViewSelect,
    });
    const page = toPage(rows, size, (row) => [toDateOnly(row.workDate) ?? '', row.id]);
    return { items: page.items.map(toRecordView), nextCursor: page.nextCursor };
  }

  private async visibleRecord(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    recordId: string,
  ): Promise<{ record: RecordRow; facts: NonNullable<Awaited<ReturnType<typeof employeeFacts>>> }> {
    const record = await db.attendanceRecord.findFirst({
      where: { organizationId, id: recordId },
      select: recordViewSelect,
    });
    if (record === null) throw new NotFoundError('Attendance record');
    const today = localToday(this.clock(), record.timeZone);
    const facts = await employeeFacts(db, organizationId, record.profileId, today);
    if (facts === null || accessTo(action, facts) === 'NONE') throw new NotFoundError('Attendance record');
    return { record, facts };
  }

  private async effectsFor(organizationId: string, memberId: string, date: string): Promise<EffectRow[]> {
    return (await recordedEffects(this.db, organizationId, memberId, date, date)).filter(
      (effect) => effect.startsOn <= date && effect.endsOn >= date,
    );
  }

  /** The work date a check-in now belongs to, its shift snapshot and the effects covering it. */
  private async dayContext(
    db: TenantDb,
    organizationId: string,
    employee: EmployeeRow,
    timeZone: string,
    policy: PolicyRow | null,
    now: Date,
  ): Promise<{ workDate: string; shift: ReturnType<ReturnType<typeof runningShifts>>; effects: EffectRow[] }> {
    const today = localToday(now, timeZone);
    const lookup = runningShifts(await assignedShifts(db, organizationId, employee.id, addDays(today, -1), today));
    const workDate = resolveWorkDate(
      now,
      timeZone,
      lookup,
      policy?.missingCheckoutAfterMinutes ?? DEFAULT_MISSING_CHECKOUT_MINUTES,
    );
    const effects = (await recordedEffects(db, organizationId, employee.memberId, workDate, workDate)).filter(
      (effect) => effect.startsOn <= workDate && effect.endsOn >= workDate,
    );
    return { workDate, shift: lookup(workDate), effects };
  }

  /** The open record a check-out applies to: checked in, not out, its missing-checkout deadline not passed. */
  private async openRecord(
    db: TenantDb,
    organizationId: string,
    employee: EmployeeRow,
    timeZone: string,
    policy: PolicyRow | null,
    now: Date,
  ): Promise<RecordRow | null> {
    const today = localToday(now, timeZone);
    const candidates = await db.attendanceRecord.findMany({
      where: {
        organizationId,
        profileId: employee.id,
        status: 'OPEN',
        workDate: { gte: fromDateOnly(addDays(today, -1)), lte: fromDateOnly(today) },
      },
      orderBy: { workDate: 'desc' },
      select: recordViewSelect,
    });
    const after = policy?.missingCheckoutAfterMinutes ?? DEFAULT_MISSING_CHECKOUT_MINUTES;
    return (
      candidates.find(
        (row) =>
          missingCheckoutDeadline(
            toDateOnly(row.workDate) ?? today,
            row.timeZone,
            row.scheduledEndAt,
            after,
            row.checkInAt,
          ).getTime() > now.getTime(),
      ) ?? null
    );
  }

  /** Evaluates what the device reported against policy and eligible locations; throws when refused. */
  private async evidence(
    db: TenantDb,
    organizationId: string,
    employee: EmployeeRow,
    workDate: string,
    mode: AttendanceMode,
    policy: PolicyRow | null,
    location: LocationInput | undefined,
  ): Promise<{
    result: 'INSIDE' | 'LOW_ACCURACY' | 'NOT_REQUIRED' | 'PERMISSION_DENIED' | 'UNAVAILABLE';
    review: boolean;
    locationId: string | null;
    locationType: string | null;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    distanceMeters: number | null;
    allowedRadiusMeters: number | null;
    accuracyThresholdMeters: number | null;
  }> {
    const none = {
      locationId: null,
      locationType: null,
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      distanceMeters: null,
      allowedRadiusMeters: null,
    };
    if (mode === 'REMOTE' || mode === 'BUSINESS_MISSION') {
      // No location is needed (or stored) for remote work and missions, even when a client sends one.
      return { result: 'NOT_REQUIRED', review: false, ...none, accuracyThresholdMeters: null };
    }
    if (policy === null) throw new AttendanceError('ATTENDANCE_NOT_CONFIGURED');
    if (location === undefined) {
      throw new InvalidInputError('location', 'A location is required for this check-in.');
    }
    if (location.status !== 'OK') {
      if (policy.missingLocationAction === 'REJECT') throw new AttendanceError('ATTENDANCE_LOCATION_REQUIRED');
      return {
        result: location.status === 'PERMISSION_DENIED' ? 'PERMISSION_DENIED' : 'UNAVAILABLE',
        review: true,
        ...none,
        accuracyThresholdMeters: policy.maxAccuracyMeters,
      };
    }
    const locations = await eligibleLocations(db, organizationId, employee.id, workDate);
    if (locations.length === 0) throw new AttendanceError('ATTENDANCE_NO_LOCATION');
    const evaluation = evaluateGeofence(location, locations, policy.maxAccuracyMeters);
    const matched = locations.find((item) => item.id === evaluation.location?.id) ?? null;
    if (evaluation.result === 'OUTSIDE') {
      throw new AttendanceError('ATTENDANCE_OUTSIDE_GEOFENCE', {
        distanceMeters: evaluation.distanceMeters,
        nearestLocation: matched?.name ?? null,
      });
    }
    if (evaluation.result === 'LOW_ACCURACY' && policy.lowAccuracyAction === 'REJECT') {
      throw new AttendanceError('ATTENDANCE_LOW_ACCURACY', {
        accuracyMeters: evaluation.accuracyMeters,
        maxAccuracyMeters: policy.maxAccuracyMeters,
      });
    }
    return {
      result: evaluation.result,
      review: evaluation.result === 'LOW_ACCURACY',
      locationId: matched?.id ?? null,
      locationType: matched?.type ?? null,
      latitude: roundCoordinate(location.latitude),
      longitude: roundCoordinate(location.longitude),
      accuracyMeters: evaluation.accuracyMeters,
      distanceMeters: evaluation.distanceMeters,
      allowedRadiusMeters: matched?.radiusMeters ?? null,
      accuracyThresholdMeters: policy.maxAccuracyMeters,
    };
  }

  private async replay(
    db: TenantDb,
    organizationId: string,
    action: ActionContext,
    kind: CheckKind,
    idempotencyKey: string,
  ): Promise<CheckResultView | null> {
    const existing = await db.attendanceEvent.findFirst({
      where: { organizationId, idempotencyKey },
      select: { ...eventViewSelect, keyOwnerMemberId: true, record: { select: recordViewSelect } },
    });
    if (existing === null) return null;
    if (existing.keyOwnerMemberId !== action.principal.memberId || existing.kind !== kind) {
      throw new ConflictError('The Idempotency-Key was already used for a different request.');
    }
    return { record: toRecordView(existing.record), event: toEventView(existing, false), replayed: true };
  }
}
