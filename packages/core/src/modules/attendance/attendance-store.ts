import type { Prisma } from '@company-ops/db';

import { addDays, fromDateOnly, localToday, toDateOnly } from '../projects/business-date.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { memberRefSelect, toPersonRef } from '../support/ticket-views.js';
import { deriveRecord } from './engine/derive.js';
import type { ActiveEffect, DerivationEvent, EffectMode } from './engine/derive.js';
import type { GeofenceLocation } from './engine/geofence.js';
import { formatMinutes, scheduleFor, shiftRunsOn } from './engine/time.js';
import type { ShiftDefinition, ShiftLookup, ShiftSnapshot } from './engine/time.js';

/**
 * Persistence helpers shared by the attendance services, the effect consumer and the sweep (ADR-0022).
 * Every query is bound to the organization; callers run inside a tenant context.
 */

export const DEFAULT_MISSING_CHECKOUT_MINUTES = 240;

// ---- Employees ----

export const employeeSelect = {
  id: true,
  memberId: true,
  fullName: true,
  employeeNumber: true,
  employmentStatus: true,
  timeZone: true,
  departmentId: true,
  department: { select: { id: true, name: true } },
  member: { select: { status: true } },
} satisfies Prisma.EmployeeProfileSelect;

export type EmployeeRow = Prisma.EmployeeProfileGetPayload<{ select: typeof employeeSelect }>;

export interface EmployeeRefView {
  readonly profileId: string;
  readonly memberId: string;
  readonly fullName: string;
  readonly employeeNumber: string;
  readonly department: { readonly id: string; readonly name: string } | null;
}

export function toEmployeeRef(row: {
  id: string;
  memberId: string;
  fullName: string;
  employeeNumber: string;
  department: { id: string; name: string } | null;
}): EmployeeRefView {
  return {
    profileId: row.id,
    memberId: row.memberId,
    fullName: row.fullName,
    employeeNumber: row.employeeNumber,
    department: row.department === null ? null : { id: row.department.id, name: row.department.name },
  };
}

export async function loadEmployeeByMember(
  db: TenantDb,
  organizationId: string,
  memberId: string,
): Promise<EmployeeRow | null> {
  return db.employeeProfile.findFirst({ where: { organizationId, memberId }, select: employeeSelect });
}

export async function loadEmployeeByProfile(
  db: TenantDb,
  organizationId: string,
  profileId: string,
): Promise<EmployeeRow | null> {
  return db.employeeProfile.findFirst({ where: { organizationId, id: profileId }, select: employeeSelect });
}

/** Attendance needs an active membership and an ACTIVE employment. */
export function canRecordAttendance(employee: EmployeeRow): boolean {
  return employee.member.status === 'ACTIVE' && employee.employmentStatus === 'ACTIVE';
}

/** Retires cached attendance dashboards once the transaction commits (ADR-0023). */
export async function announceAttendanceChange(db: TenantDb, organizationId: string, recordId: string): Promise<void> {
  await enqueueOutboxEvent(db, organizationId, {
    eventType: 'dashboard.changed',
    aggregateType: 'attendance_record',
    aggregateId: recordId,
    payload: { domains: ['attendance'] },
  });
}

export async function organizationZone(db: TenantDb, organizationId: string): Promise<string> {
  const organization = await db.organization.findFirstOrThrow({
    where: { id: organizationId },
    select: { timeZone: true },
  });
  return organization.timeZone;
}

/** The employee's attendance zone: profile zone, else the organization zone. */
export async function attendanceZone(
  db: TenantDb,
  organizationId: string,
  employee: { timeZone: string | null },
): Promise<string> {
  return employee.timeZone ?? (await organizationZone(db, organizationId));
}

// ---- Policy ----

export interface PolicyRow {
  readonly id: string;
  readonly maxAccuracyMeters: number;
  readonly lowAccuracyAction: 'FLAG_FOR_REVIEW' | 'REJECT';
  readonly missingLocationAction: 'FLAG_FOR_REVIEW' | 'REJECT';
  readonly missingCheckoutAfterMinutes: number;
  readonly version: number;
  readonly updatedAt: Date;
}

export async function loadPolicy(db: TenantDb, organizationId: string): Promise<PolicyRow | null> {
  return db.attendancePolicy.findFirst({
    where: { organizationId },
    select: {
      id: true,
      maxAccuracyMeters: true,
      lowAccuracyAction: true,
      missingLocationAction: true,
      missingCheckoutAfterMinutes: true,
      version: true,
      updatedAt: true,
    },
  });
}

// ---- Shifts ----

const shiftDefinitionSelect = {
  id: true,
  name: true,
  startMinute: true,
  endMinute: true,
  crossesMidnight: true,
  lateGraceMinutes: true,
  earlyLeaveGraceMinutes: true,
  weekdays: true,
  active: true,
} satisfies Prisma.ShiftSelect;

type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof shiftDefinitionSelect }>;

export function toShiftDefinition(row: ShiftRow): ShiftDefinition {
  return {
    shiftId: row.id,
    name: row.name,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    crossesMidnight: row.crossesMidnight,
    lateGraceMinutes: row.lateGraceMinutes,
    earlyLeaveGraceMinutes: row.earlyLeaveGraceMinutes,
    weekdays: [...row.weekdays],
  };
}

/**
 * The assigned shift per date for one employee within [from, to]: the assignment covering the date with
 * an active shift (a deactivated shift no longer schedules anyone). Weekdays are not applied here.
 */
export async function assignedShifts(
  db: TenantDb,
  organizationId: string,
  profileId: string,
  from: string,
  to: string,
): Promise<ShiftLookup> {
  return (await assignedShiftsOf(db, organizationId, [profileId], from, to))(profileId);
}

/** {@link assignedShifts} for many employees in one query (team views); at most 50 assignments each. */
export async function assignedShiftsOf(
  db: TenantDb,
  organizationId: string,
  profileIds: readonly string[],
  from: string,
  to: string,
): Promise<(profileId: string) => ShiftLookup> {
  const rows =
    profileIds.length === 0
      ? []
      : await db.employeeShiftAssignment.findMany({
          where: {
            organizationId,
            profileId: { in: [...profileIds] },
            effectiveFrom: { lte: fromDateOnly(to) },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: fromDateOnly(from) } }],
          },
          select: { profileId: true, effectiveFrom: true, effectiveTo: true, shift: { select: shiftDefinitionSelect } },
          orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
          take: 50 * profileIds.length,
        });
  const byProfile = new Map<string, { from: string; to: string | null; shift: ShiftDefinition | null }[]>();
  for (const row of rows) {
    const list = byProfile.get(row.profileId) ?? [];
    list.push({
      from: toDateOnly(row.effectiveFrom) ?? '',
      to: toDateOnly(row.effectiveTo),
      shift: row.shift.active ? toShiftDefinition(row.shift) : null,
    });
    byProfile.set(row.profileId, list);
  }
  return (profileId: string) => {
    const assignments = byProfile.get(profileId) ?? [];
    return (date: string) => {
      const match = assignments.find((item) => item.from <= date && (item.to === null || item.to >= date));
      return match?.shift ?? null;
    };
  };
}

/** Only shifts that run on that weekday (for scheduling and work-date resolution). */
export const runningShifts =
  (lookup: ShiftLookup): ShiftLookup =>
  (date: string) => {
    const shift = lookup(date);
    return shift !== null && shiftRunsOn(shift, date) ? shift : null;
  };

export function shiftRefView(snapshot: ShiftSnapshot): {
  id: string | null;
  name: string;
  start: string;
  end: string;
  crossesMidnight: boolean;
  lateGraceMinutes: number;
  earlyLeaveGraceMinutes: number;
} {
  return {
    id: snapshot.shiftId,
    name: snapshot.name,
    start: formatMinutes(snapshot.startMinute),
    end: formatMinutes(snapshot.endMinute),
    crossesMidnight: snapshot.crossesMidnight,
    lateGraceMinutes: snapshot.lateGraceMinutes,
    earlyLeaveGraceMinutes: snapshot.earlyLeaveGraceMinutes,
  };
}

// ---- Effects ----

export interface EffectRow {
  readonly id: string;
  readonly requestId: string;
  readonly mode: EffectMode;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly startsAtMinute: number | null;
  readonly endsAtMinute: number | null;
}

/** Approved (RECORDED) attendance effects of the member overlapping [from, to]; corrections excluded. */
export async function recordedEffects(
  db: TenantDb,
  organizationId: string,
  memberId: string,
  from: string,
  to: string,
): Promise<EffectRow[]> {
  return (await recordedEffectsOf(db, organizationId, [memberId], from, to))(memberId);
}

/** {@link recordedEffects} for many members in one query (team views); at most 200 effects each. */
export async function recordedEffectsOf(
  db: TenantDb,
  organizationId: string,
  memberIds: readonly string[],
  from: string,
  to: string,
): Promise<(memberId: string) => EffectRow[]> {
  const rows =
    memberIds.length === 0
      ? []
      : await db.requestEffect.findMany({
          where: {
            organizationId,
            kind: 'ATTENDANCE',
            status: 'RECORDED',
            mode: { in: ['LEAVE', 'REMOTE', 'BUSINESS_MISSION', 'SHORT_LEAVE'] },
            startsOn: { lte: fromDateOnly(to) },
            endsOn: { gte: fromDateOnly(from) },
            request: { requesterMemberId: { in: [...memberIds] } },
          },
          select: {
            id: true,
            requestId: true,
            mode: true,
            startsOn: true,
            endsOn: true,
            startsAtMinute: true,
            endsAtMinute: true,
            request: { select: { requesterMemberId: true } },
          },
          orderBy: [{ startsOn: 'asc' }, { id: 'asc' }],
          take: 200 * memberIds.length,
        });
  const byMember = new Map<string, EffectRow[]>();
  for (const row of rows) {
    if (row.mode === 'CORRECTION') continue;
    const list = byMember.get(row.request.requesterMemberId) ?? [];
    list.push({
      id: row.id,
      requestId: row.requestId,
      mode: row.mode,
      startsOn: toDateOnly(row.startsOn) ?? '',
      endsOn: toDateOnly(row.endsOn) ?? '',
      startsAtMinute: row.startsAtMinute,
      endsAtMinute: row.endsAtMinute,
    });
    byMember.set(row.request.requesterMemberId, list);
  }
  return (memberId: string) => byMember.get(memberId) ?? [];
}

export function effectsOn(effects: readonly EffectRow[], date: string): ActiveEffect[] {
  return effects
    .filter((effect) => effect.startsOn <= date && effect.endsOn >= date)
    .map((effect) => ({
      mode: effect.mode,
      requestId: effect.requestId,
      startsAtMinute: effect.startsAtMinute,
      endsAtMinute: effect.endsAtMinute,
    }));
}

// ---- Locations ----

/**
 * Locations an employee may check in at on `date` (server-computed, ADR-0022): active OFFICE locations,
 * plus active locations linked to ACTIVE projects on which the employee holds an active membership.
 */
export async function eligibleLocations(
  db: TenantDb,
  organizationId: string,
  profileId: string,
  date: string,
): Promise<(GeofenceLocation & { name: string })[]> {
  const day = fromDateOnly(date);
  const rows = await db.workLocation.findMany({
    where: {
      organizationId,
      active: true,
      OR: [
        { type: 'OFFICE' },
        {
          projectLocations: {
            some: {
              project: {
                status: 'ACTIVE',
                members: {
                  some: {
                    profileId,
                    startDate: { lte: day },
                    OR: [{ endDate: null }, { endDate: { gte: day } }],
                  },
                },
              },
            },
          },
        },
      ],
    },
    select: { id: true, name: true, type: true, latitude: true, longitude: true, allowedRadiusMeters: true },
    orderBy: { id: 'asc' },
    take: 200,
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    latitude: row.latitude.toNumber(),
    longitude: row.longitude.toNumber(),
    radiusMeters: row.allowedRadiusMeters,
  }));
}

// ---- Records ----

export const recordViewSelect = {
  id: true,
  workDate: true,
  timeZone: true,
  mode: true,
  status: true,
  shiftId: true,
  shiftName: true,
  shiftStartMinute: true,
  shiftEndMinute: true,
  shiftCrossesMidnight: true,
  lateGraceMinutes: true,
  earlyLeaveGraceMinutes: true,
  scheduledStartAt: true,
  scheduledEndAt: true,
  checkInAt: true,
  checkOutAt: true,
  lateMinutes: true,
  earlyLeaveMinutes: true,
  workedMinutes: true,
  needsReview: true,
  adjusted: true,
  sourceRequestId: true,
  missingCheckoutAt: true,
  version: true,
  memberId: true,
  profileId: true,
  profile: {
    select: {
      id: true,
      memberId: true,
      fullName: true,
      employeeNumber: true,
      department: { select: { id: true, name: true } },
    },
  },
  checkInLocation: { select: { id: true, name: true } },
  checkOutLocation: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceRecordSelect;

export type RecordRow = Prisma.AttendanceRecordGetPayload<{ select: typeof recordViewSelect }>;

export interface AttendanceRecordView {
  readonly id: string;
  readonly workDate: string;
  readonly timeZone: string;
  readonly employee: EmployeeRefView;
  readonly mode: RecordRow['mode'];
  readonly status: RecordRow['status'];
  readonly shift: ReturnType<typeof shiftRefView> | null;
  readonly scheduledStartAt: string | null;
  readonly scheduledEndAt: string | null;
  readonly checkInAt: string | null;
  readonly checkOutAt: string | null;
  readonly checkInLocation: { readonly id: string; readonly name: string } | null;
  readonly checkOutLocation: { readonly id: string; readonly name: string } | null;
  readonly lateMinutes: number;
  readonly earlyLeaveMinutes: number;
  readonly workedMinutes: number | null;
  readonly needsReview: boolean;
  readonly adjusted: boolean;
  readonly sourceRequestId: string | null;
  readonly version: number;
}

export function recordSnapshot(row: {
  shiftId: string | null;
  shiftName: string | null;
  shiftStartMinute: number | null;
  shiftEndMinute: number | null;
  shiftCrossesMidnight: boolean | null;
  lateGraceMinutes: number | null;
  earlyLeaveGraceMinutes: number | null;
}): ShiftSnapshot | null {
  if (row.shiftStartMinute === null || row.shiftEndMinute === null) return null;
  return {
    shiftId: row.shiftId,
    name: row.shiftName ?? '',
    startMinute: row.shiftStartMinute,
    endMinute: row.shiftEndMinute,
    crossesMidnight: row.shiftCrossesMidnight ?? false,
    lateGraceMinutes: row.lateGraceMinutes ?? 0,
    earlyLeaveGraceMinutes: row.earlyLeaveGraceMinutes ?? 0,
  };
}

export function toRecordView(row: RecordRow): AttendanceRecordView {
  const snapshot = recordSnapshot(row);
  return {
    id: row.id,
    workDate: toDateOnly(row.workDate) ?? '',
    timeZone: row.timeZone,
    employee: toEmployeeRef(row.profile),
    mode: row.mode,
    status: row.status,
    shift: snapshot === null ? null : shiftRefView(snapshot),
    scheduledStartAt: row.scheduledStartAt?.toISOString() ?? null,
    scheduledEndAt: row.scheduledEndAt?.toISOString() ?? null,
    checkInAt: row.checkInAt?.toISOString() ?? null,
    checkOutAt: row.checkOutAt?.toISOString() ?? null,
    checkInLocation: row.checkInLocation,
    checkOutLocation: row.checkOutLocation,
    lateMinutes: row.lateMinutes,
    earlyLeaveMinutes: row.earlyLeaveMinutes,
    workedMinutes: row.workedMinutes,
    needsReview: row.needsReview,
    adjusted: row.adjusted,
    sourceRequestId: row.sourceRequestId,
    version: row.version,
  };
}

export async function findRecord(
  db: TenantDb,
  organizationId: string,
  profileId: string,
  workDate: string,
): Promise<RecordRow | null> {
  return db.attendanceRecord.findFirst({
    where: { organizationId, profileId, workDate: fromDateOnly(workDate) },
    select: recordViewSelect,
  });
}

/**
 * The record of an employee and work date, created with the shift snapshot that applies on that date
 * when it does not exist yet. Callers hold the employee's attendance lock, so creation never races.
 */
export async function ensureRecord(
  db: TenantDb,
  organizationId: string,
  employee: { id: string; memberId: string },
  workDate: string,
  timeZone: string,
  shift: ShiftSnapshot | null,
): Promise<RecordRow> {
  const existing = await findRecord(db, organizationId, employee.id, workDate);
  if (existing !== null) return existing;
  const schedule = shift === null ? null : scheduleFor(shift, workDate, timeZone);
  const created = await db.attendanceRecord.create({
    data: {
      organizationId,
      profileId: employee.id,
      memberId: employee.memberId,
      workDate: fromDateOnly(workDate),
      timeZone,
      status: 'SCHEDULED',
      shiftId: shift?.shiftId ?? null,
      shiftName: shift?.name ?? null,
      shiftStartMinute: shift?.startMinute ?? null,
      shiftEndMinute: shift?.endMinute ?? null,
      shiftCrossesMidnight: shift?.crossesMidnight ?? null,
      lateGraceMinutes: shift?.lateGraceMinutes ?? null,
      earlyLeaveGraceMinutes: shift?.earlyLeaveGraceMinutes ?? null,
      scheduledStartAt: schedule?.start ?? null,
      scheduledEndAt: schedule?.end ?? null,
    },
    select: { id: true },
  });
  const row = await db.attendanceRecord.findFirstOrThrow({
    where: { organizationId, id: created.id },
    select: recordViewSelect,
  });
  return row;
}

const derivationEventSelect = {
  id: true,
  kind: true,
  recordedAt: true,
  effectiveAt: true,
  mode: true,
  workLocationId: true,
  reviewStatus: true,
  adjustmentId: true,
  previousCheckInAt: true,
  previousCheckOutAt: true,
  adjustedCheckInAt: true,
  adjustedCheckOutAt: true,
} satisfies Prisma.AttendanceEventSelect;

/**
 * Recomputes the derived state of a record from its complete event log, its own snapshot and the effects
 * active on its date (ADR-0022), and stores it. Returns the updated record.
 */
export async function rederiveRecord(
  db: TenantDb,
  organizationId: string,
  recordId: string,
  now: Date,
): Promise<RecordRow> {
  const record = await db.attendanceRecord.findFirstOrThrow({
    where: { organizationId, id: recordId },
    select: recordViewSelect,
  });
  const workDate = toDateOnly(record.workDate) ?? '';
  const events: DerivationEvent[] = await db.attendanceEvent.findMany({
    where: { organizationId, recordId },
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    select: derivationEventSelect,
    take: 1000,
  });
  const effects = effectsOn(await recordedEffects(db, organizationId, record.memberId, workDate, workDate), workDate);
  const derived = deriveRecord({
    workDate,
    timeZone: record.timeZone,
    today: localToday(now, record.timeZone),
    scheduledStartAt: record.scheduledStartAt,
    scheduledEndAt: record.scheduledEndAt,
    lateGraceMinutes: record.lateGraceMinutes,
    earlyLeaveGraceMinutes: record.earlyLeaveGraceMinutes,
    events,
    effects,
  });
  await db.attendanceRecord.updateMany({
    where: { organizationId, id: recordId },
    data: { ...derived, version: { increment: 1 } },
  });
  return db.attendanceRecord.findFirstOrThrow({ where: { organizationId, id: recordId }, select: recordViewSelect });
}

// ---- Events ----

export const eventViewSelect = {
  id: true,
  kind: true,
  recordedAt: true,
  effectiveAt: true,
  mode: true,
  workLocation: { select: { id: true, name: true } },
  latitude: true,
  geofenceResult: true,
  distanceMeters: true,
  accuracyMeters: true,
  allowedRadiusMeters: true,
  accuracyThresholdMeters: true,
  reviewStatus: true,
  reviewedBy: { select: memberRefSelect },
  reviewedAt: true,
  reviewNote: true,
  actor: { select: memberRefSelect },
  requestId: true,
  reasonCode: true,
  note: true,
  previousCheckInAt: true,
  previousCheckOutAt: true,
  adjustedCheckInAt: true,
  adjustedCheckOutAt: true,
  ipAddress: true,
  userAgent: true,
  recordId: true,
  profileId: true,
} satisfies Prisma.AttendanceEventSelect;

export type EventRow = Prisma.AttendanceEventGetPayload<{ select: typeof eventViewSelect }>;

export interface AttendanceEventView {
  readonly id: string;
  readonly kind: EventRow['kind'];
  readonly recordedAt: string;
  readonly effectiveAt: string | null;
  readonly mode: EventRow['mode'];
  readonly location: { readonly id: string; readonly name: string } | null;
  readonly geofenceResult: EventRow['geofenceResult'];
  readonly distanceMeters: number | null;
  readonly accuracyMeters: number | null;
  readonly allowedRadiusMeters: number | null;
  readonly accuracyThresholdMeters: number | null;
  readonly hasCoordinates: boolean;
  readonly reviewStatus: EventRow['reviewStatus'];
  readonly reviewedBy: ReturnType<typeof toPersonRef> | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
  readonly actor: ReturnType<typeof toPersonRef> | null;
  readonly requestId: string | null;
  readonly reasonCode: EventRow['reasonCode'];
  readonly note: string | null;
  readonly previousCheckInAt: string | null;
  readonly previousCheckOutAt: string | null;
  readonly adjustedCheckInAt: string | null;
  readonly adjustedCheckOutAt: string | null;
  readonly device: { readonly ipAddress: string | null; readonly userAgent: string | null } | null;
}

/** Coordinates are never returned; device details only to `attendance.admin`. */
export function toEventView(row: EventRow, showDevice: boolean): AttendanceEventView {
  return {
    id: row.id,
    kind: row.kind,
    recordedAt: row.recordedAt.toISOString(),
    effectiveAt: row.effectiveAt?.toISOString() ?? null,
    mode: row.mode,
    location: row.workLocation,
    geofenceResult: row.geofenceResult,
    distanceMeters: row.distanceMeters,
    accuracyMeters: row.accuracyMeters,
    allowedRadiusMeters: row.allowedRadiusMeters,
    accuracyThresholdMeters: row.accuracyThresholdMeters,
    hasCoordinates: row.latitude !== null,
    reviewStatus: row.reviewStatus,
    reviewedBy: row.reviewedBy === null ? null : toPersonRef(row.reviewedBy),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    actor: row.actor === null ? null : toPersonRef(row.actor),
    requestId: row.requestId,
    reasonCode: row.reasonCode,
    note: row.note,
    previousCheckInAt: row.previousCheckInAt?.toISOString() ?? null,
    previousCheckOutAt: row.previousCheckOutAt?.toISOString() ?? null,
    adjustedCheckInAt: row.adjustedCheckInAt?.toISOString() ?? null,
    adjustedCheckOutAt: row.adjustedCheckOutAt?.toISOString() ?? null,
    device: showDevice ? { ipAddress: row.ipAddress, userAgent: row.userAgent } : null,
  };
}

/** Bounds a date range to at most `maxDays` (inclusive), defaulting to the last 31 days ending today. */
export function boundedRange(
  from: string | undefined,
  to: string | undefined,
  today: string,
  maxDays: number,
): { from: string; to: string } | null {
  const end = to ?? today;
  const start = from ?? addDays(end, -30);
  if (start > end) return null;
  if (addDays(start, maxDays - 1) < end) return null;
  return { from: start, to: end };
}
