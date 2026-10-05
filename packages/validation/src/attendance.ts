import { z } from 'zod';

import { csvEnum } from './projects.js';
import {
  booleanQuerySchema,
  dataResponseSchema,
  isoDateTimeSchema,
  listResponseSchema,
  pageQueryShape,
  pageResponseSchema,
} from './pagination.js';

// ---- Enums (mirror the Prisma enums, ADR-0022) ----

export const attendanceModeSchema = z.enum(['OFFICE', 'SITE', 'REMOTE', 'BUSINESS_MISSION', 'LEAVE']);
export const attendanceRecordStatusSchema = z.enum([
  'OPEN',
  'COMPLETE',
  'MISSING_CHECKOUT',
  'EXCUSED',
  'ABSENT',
  'SCHEDULED',
]);
/**
 * Per-day status shown in history and team views, derived for days with or without a record. Future days
 * are `UPCOMING`, never absent.
 */
export const attendanceDayStatusSchema = z.enum([
  'CHECKED_IN',
  'COMPLETE',
  'MISSING_CHECKOUT',
  'ABSENT',
  'NOT_STARTED',
  'ON_LEAVE',
  'ON_MISSION',
  'OFF_DAY',
  'NO_SCHEDULE',
  'UPCOMING',
]);
export const attendanceEventKindSchema = z.enum([
  'CHECK_IN',
  'CHECK_OUT',
  'ADJUSTED',
  'ADJUSTMENT_REVERTED',
  'SYSTEM_MISSING_CHECKOUT',
  'EFFECT_APPLIED',
  'EFFECT_REVOKED',
]);
export const geofenceResultSchema = z.enum([
  'INSIDE',
  'OUTSIDE',
  'LOW_ACCURACY',
  'NOT_REQUIRED',
  'PERMISSION_DENIED',
  'UNAVAILABLE',
]);
export const attendanceReviewStatusSchema = z.enum(['NOT_REQUIRED', 'PENDING_REVIEW', 'ACCEPTED', 'REJECTED']);
export const attendanceAdjustmentReasonSchema = z.enum([
  'FORGOT_CHECK_IN',
  'FORGOT_CHECK_OUT',
  'WRONG_LOCATION',
  'SYSTEM_ISSUE',
  'INCORRECT_TIME',
]);
export const attendanceAccuracyActionSchema = z.enum(['FLAG_FOR_REVIEW', 'REJECT']);
/** Derived from the Phase 6 request status plus applied/reverted markers. */
export const attendanceCorrectionStatusSchema = z.enum(['PENDING', 'APPLIED', 'REJECTED', 'CANCELLED', 'REVERTED']);

const isoDateSchema = z.iso.date();
/** Local wall time `HH:MM` (24 h). */
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const versionSchema = z.number().int().min(1);
const noteSchema = z.string().trim().min(1).max(1000);
const personRefSchema = z.strictObject({ memberId: z.uuid(), name: z.string(), active: z.boolean() });
const namedRefSchema = z.strictObject({ id: z.uuid(), name: z.string() });

// ---- Check-in / check-out ----

/**
 * What the device reported on an explicit check-in/out. Coordinates only with `OK`; otherwise the reason
 * the browser gave (recorded as such, never silently accepted). No client time, distance or location id.
 */
export const attendanceLocationInputSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('OK'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    /** Meters, as reported by the browser (always sent with coordinates, SECURITY section 9). */
    accuracy: z.number().min(0).max(100_000),
  }),
  z.strictObject({ status: z.enum(['PERMISSION_DENIED', 'UNAVAILABLE', 'TIMEOUT', 'UNSUPPORTED']) }),
]);

export const attendanceCheckRequestSchema = z.strictObject({
  /** Omitted when the day does not require a location (remote work, business mission). */
  location: attendanceLocationInputSchema.optional(),
});

export const attendanceIdempotencyKeySchema = z.uuid();

// ---- Views ----

export const attendanceShiftRefSchema = z.strictObject({
  id: z.uuid().nullable(),
  name: z.string(),
  start: localTimeSchema,
  end: localTimeSchema,
  crossesMidnight: z.boolean(),
  lateGraceMinutes: z.number().int(),
  earlyLeaveGraceMinutes: z.number().int(),
});

export const attendanceEmployeeRefSchema = z.strictObject({
  profileId: z.uuid(),
  memberId: z.uuid(),
  fullName: z.string(),
  employeeNumber: z.string(),
  department: namedRefSchema.nullable(),
});

export const attendanceRecordSchema = z.strictObject({
  id: z.uuid(),
  workDate: isoDateSchema,
  timeZone: z.string(),
  employee: attendanceEmployeeRefSchema,
  mode: attendanceModeSchema.nullable(),
  status: attendanceRecordStatusSchema,
  shift: attendanceShiftRefSchema.nullable(),
  scheduledStartAt: isoDateTimeSchema.nullable(),
  scheduledEndAt: isoDateTimeSchema.nullable(),
  checkInAt: isoDateTimeSchema.nullable(),
  checkOutAt: isoDateTimeSchema.nullable(),
  checkInLocation: namedRefSchema.nullable(),
  checkOutLocation: namedRefSchema.nullable(),
  lateMinutes: z.number().int(),
  earlyLeaveMinutes: z.number().int(),
  workedMinutes: z.number().int().nullable(),
  needsReview: z.boolean(),
  adjusted: z.boolean(),
  sourceRequestId: z.uuid().nullable(),
  version: z.number().int(),
});

export const attendanceEventSchema = z.strictObject({
  id: z.uuid(),
  kind: attendanceEventKindSchema,
  recordedAt: isoDateTimeSchema,
  effectiveAt: isoDateTimeSchema.nullable(),
  mode: attendanceModeSchema.nullable(),
  location: namedRefSchema.nullable(),
  geofenceResult: geofenceResultSchema.nullable(),
  distanceMeters: z.number().int().nullable(),
  accuracyMeters: z.number().int().nullable(),
  allowedRadiusMeters: z.number().int().nullable(),
  accuracyThresholdMeters: z.number().int().nullable(),
  /** Whether coordinates are still stored (they are never returned; retention may clear them). */
  hasCoordinates: z.boolean(),
  reviewStatus: attendanceReviewStatusSchema,
  reviewedBy: personRefSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  reviewNote: z.string().nullable(),
  actor: personRefSchema.nullable(),
  requestId: z.uuid().nullable(),
  reasonCode: attendanceAdjustmentReasonSchema.nullable(),
  note: z.string().nullable(),
  previousCheckInAt: isoDateTimeSchema.nullable(),
  previousCheckOutAt: isoDateTimeSchema.nullable(),
  adjustedCheckInAt: isoDateTimeSchema.nullable(),
  adjustedCheckOutAt: isoDateTimeSchema.nullable(),
  /** IP address and user agent: `attendance.admin` only, otherwise null. */
  device: z.strictObject({ ipAddress: z.string().nullable(), userAgent: z.string().nullable() }).nullable(),
});

export const attendanceRecordDetailSchema = z.strictObject({
  record: attendanceRecordSchema,
  events: z.array(attendanceEventSchema),
  canReview: z.boolean(),
  canCorrect: z.boolean(),
});

export const attendanceEffectRefSchema = z.strictObject({
  mode: z.enum(['LEAVE', 'REMOTE', 'BUSINESS_MISSION', 'SHORT_LEAVE']),
  requestId: z.uuid(),
  startsOn: isoDateSchema,
  endsOn: isoDateSchema,
  fromTime: localTimeSchema.nullable(),
  toTime: localTimeSchema.nullable(),
});

export const attendanceTodaySchema = z.strictObject({
  serverTime: isoDateTimeSchema,
  workDate: isoDateSchema,
  timeZone: z.string(),
  /** False with a reason when the member cannot record attendance at all. */
  eligible: z.boolean(),
  ineligibleReason: z.enum(['NO_PROFILE', 'NOT_ACTIVE']).nullable(),
  /** False until an administrator saves the accuracy policy (location check-ins are refused). */
  configured: z.boolean(),
  locationRequired: z.boolean(),
  plannedMode: attendanceModeSchema.nullable(),
  shift: attendanceShiftRefSchema.nullable(),
  scheduledStartAt: isoDateTimeSchema.nullable(),
  scheduledEndAt: isoDateTimeSchema.nullable(),
  record: attendanceRecordSchema.nullable(),
  nextAction: z.enum(['CHECK_IN', 'CHECK_OUT', 'NONE']),
  effects: z.array(attendanceEffectRefSchema),
  /** Accuracy threshold the server applies (meters), for the UI hint; null when not configured. */
  maxAccuracyMeters: z.number().int().nullable(),
  eligibleLocationCount: z.number().int(),
});

export const attendanceCheckResultSchema = z.strictObject({
  record: attendanceRecordSchema,
  event: attendanceEventSchema,
  /** True when this response replays an earlier request with the same Idempotency-Key. */
  replayed: z.boolean(),
});

export const attendanceTodayResponseSchema = dataResponseSchema(attendanceTodaySchema);
export const attendanceCheckResponseSchema = dataResponseSchema(attendanceCheckResultSchema);
export const attendanceRecordResponseSchema = dataResponseSchema(attendanceRecordSchema);
export const attendanceRecordDetailResponseSchema = dataResponseSchema(attendanceRecordDetailSchema);
export const attendanceRecordPageResponseSchema = pageResponseSchema(attendanceRecordSchema);

// ---- Queries ----

const dateRangeShape = {
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
};

export const myAttendanceQuerySchema = z.strictObject({ ...dateRangeShape, ...pageQueryShape });

export const teamAttendanceQuerySchema = z.strictObject({
  ...dateRangeShape,
  status: csvEnum(attendanceRecordStatusSchema).optional(),
  departmentId: z.uuid().optional(),
  profileId: z.uuid().optional(),
  needsReview: booleanQuerySchema.optional(),
  late: booleanQuerySchema.optional(),
  ...pageQueryShape,
});

export const attendanceExportQuerySchema = z.strictObject({
  from: isoDateSchema,
  to: isoDateSchema,
  status: csvEnum(attendanceRecordStatusSchema).optional(),
  departmentId: z.uuid().optional(),
  profileId: z.uuid().optional(),
});

/** One employee on one date for the team "day" view (records plus derived status for everyone in scope). */
export const attendanceTeamDaySchema = z.strictObject({
  employee: attendanceEmployeeRefSchema,
  date: isoDateSchema,
  status: attendanceDayStatusSchema,
  plannedMode: attendanceModeSchema.nullable(),
  record: attendanceRecordSchema.nullable(),
});
export const attendanceTeamDayPageResponseSchema = pageResponseSchema(attendanceTeamDaySchema);
/** Dashboard attendance buckets (ADR-0023); one employee can be in several (present and late). */
export const attendanceDayBucketSchema = z.enum([
  'PRESENT',
  'REMOTE',
  'ON_LEAVE',
  'ON_MISSION',
  'LATE',
  'NOT_CHECKED_IN',
  'MISSING_CHECKOUT',
]);

export const attendanceTeamDayQuerySchema = z.strictObject({
  date: isoDateSchema.optional(),
  departmentId: z.uuid().optional(),
  /** Only employees in this bucket (the dashboard count's deep link). */
  bucket: attendanceDayBucketSchema.optional(),
  ...pageQueryShape,
});

// ---- Reviews ----

export const attendanceReviewItemSchema = z.strictObject({
  event: attendanceEventSchema,
  record: attendanceRecordSchema,
});
export const attendanceReviewPageResponseSchema = pageResponseSchema(attendanceReviewItemSchema);
export const attendanceReviewQuerySchema = z.strictObject({ ...pageQueryShape });

export const attendanceReviewRequestSchema = z.strictObject({
  decision: z.enum(['ACCEPTED', 'REJECTED']),
  note: noteSchema.optional(),
});

// ---- Corrections ----

const correctionTimesShape = {
  checkIn: localTimeSchema.optional(),
  checkOut: localTimeSchema.optional(),
  /** The corrected check-out falls on the next local day (overnight shifts). */
  checkOutNextDay: z.boolean().optional(),
};

const atLeastOneTime = (value: { checkIn?: string | undefined; checkOut?: string | undefined }): boolean =>
  value.checkIn !== undefined || value.checkOut !== undefined;

export const createAttendanceCorrectionSchema = z
  .strictObject({
    workDate: isoDateSchema,
    reasonCode: attendanceAdjustmentReasonSchema,
    ...correctionTimesShape,
    details: z.string().trim().min(1).max(2000),
  })
  .refine(atLeastOneTime, { message: 'a corrected check-in or check-out is required', path: ['checkIn'] });

export const attendanceCorrectionSchema = z.strictObject({
  id: z.uuid(),
  workDate: isoDateSchema,
  reasonCode: attendanceAdjustmentReasonSchema,
  requestedCheckInAt: isoDateTimeSchema.nullable(),
  requestedCheckOutAt: isoDateTimeSchema.nullable(),
  originalCheckInAt: isoDateTimeSchema.nullable(),
  originalCheckOutAt: isoDateTimeSchema.nullable(),
  details: z.string(),
  status: attendanceCorrectionStatusSchema,
  request: z.strictObject({ id: z.uuid(), number: z.number().int() }),
  appliedAt: isoDateTimeSchema.nullable(),
  revertedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export const attendanceCorrectionResponseSchema = dataResponseSchema(attendanceCorrectionSchema);
export const attendanceCorrectionPageResponseSchema = pageResponseSchema(attendanceCorrectionSchema);
export const attendanceCorrectionQuerySchema = z.strictObject({ ...pageQueryShape });

/** Privileged direct correction (`attendance.admin`, fresh MFA): always with a reason and a note. */
export const adminAttendanceCorrectionSchema = z
  .strictObject({
    profileId: z.uuid(),
    workDate: isoDateSchema,
    reasonCode: attendanceAdjustmentReasonSchema,
    ...correctionTimesShape,
    note: noteSchema,
    /** Current record version when the record exists (optimistic concurrency); null when it does not. */
    version: versionSchema.nullable(),
  })
  .refine(atLeastOneTime, { message: 'a corrected check-in or check-out is required', path: ['checkIn'] });

// ---- Policy ----

export const attendancePolicySchema = z.strictObject({
  configured: z.boolean(),
  maxAccuracyMeters: z.number().int().nullable(),
  lowAccuracyAction: attendanceAccuracyActionSchema.nullable(),
  missingLocationAction: attendanceAccuracyActionSchema.nullable(),
  missingCheckoutAfterMinutes: z.number().int().nullable(),
  version: z.number().int().nullable(),
  updatedAt: isoDateTimeSchema.nullable(),
});
export const attendancePolicyResponseSchema = dataResponseSchema(attendancePolicySchema);
export const setAttendancePolicySchema = z.strictObject({
  maxAccuracyMeters: z.number().int().min(10).max(5000),
  lowAccuracyAction: attendanceAccuracyActionSchema,
  missingLocationAction: attendanceAccuracyActionSchema,
  missingCheckoutAfterMinutes: z.number().int().min(30).max(1440),
  /** Null creates the policy; otherwise the current version. */
  version: z.number().int().min(1).nullable(),
});

// ---- Shifts and assignments ----

const weekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .refine((days) => new Set(days).size === days.length, 'weekdays must be unique');

export const shiftSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  start: localTimeSchema,
  end: localTimeSchema,
  crossesMidnight: z.boolean(),
  lateGraceMinutes: z.number().int(),
  earlyLeaveGraceMinutes: z.number().int(),
  weekdays: z.array(z.number().int()),
  active: z.boolean(),
  activeAssignments: z.number().int(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export const shiftResponseSchema = dataResponseSchema(shiftSchema);
export const shiftListResponseSchema = listResponseSchema(shiftSchema);
export const shiftListQuerySchema = z.strictObject({
  includeInactive: booleanQuerySchema.optional(),
});

const shiftShape = {
  name: z.string().trim().min(1).max(120),
  start: localTimeSchema,
  end: localTimeSchema,
  lateGraceMinutes: z.number().int().min(0).max(240),
  earlyLeaveGraceMinutes: z.number().int().min(0).max(240),
  weekdays: weekdaysSchema,
};

export const createShiftSchema = z
  .strictObject({ ...shiftShape, active: z.boolean().optional() })
  .refine((value) => value.start !== value.end, { message: 'start and end must differ', path: ['end'] });

export const updateShiftSchema = z
  .strictObject({
    name: shiftShape.name.optional(),
    start: localTimeSchema.optional(),
    end: localTimeSchema.optional(),
    lateGraceMinutes: shiftShape.lateGraceMinutes.optional(),
    earlyLeaveGraceMinutes: shiftShape.earlyLeaveGraceMinutes.optional(),
    weekdays: weekdaysSchema.optional(),
    active: z.boolean().optional(),
    version: versionSchema,
  })
  .refine((value) => Object.keys(value).length > 1, 'at least one field is required');

export const shiftAssignmentSchema = z.strictObject({
  id: z.uuid(),
  employee: attendanceEmployeeRefSchema,
  shift: namedRefSchema,
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.nullable(),
  version: z.number().int(),
  createdAt: isoDateTimeSchema,
});
export const shiftAssignmentResponseSchema = dataResponseSchema(shiftAssignmentSchema);
export const shiftAssignmentPageResponseSchema = pageResponseSchema(shiftAssignmentSchema);
export const shiftAssignmentQuerySchema = z.strictObject({
  profileId: z.uuid().optional(),
  shiftId: z.uuid().optional(),
  activeOn: isoDateSchema.optional(),
  ...pageQueryShape,
});
export const createShiftAssignmentSchema = z
  .strictObject({
    profileId: z.uuid(),
    shiftId: z.uuid(),
    effectiveFrom: isoDateSchema,
    effectiveTo: isoDateSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.effectiveTo === undefined || value.effectiveTo === null || value.effectiveTo >= value.effectiveFrom,
    {
      message: 'effectiveTo must not be before effectiveFrom',
      path: ['effectiveTo'],
    },
  );
export const endShiftAssignmentSchema = z.strictObject({ effectiveTo: isoDateSchema, version: versionSchema });

export type AttendanceMode = z.infer<typeof attendanceModeSchema>;
export type AttendanceRecordStatus = z.infer<typeof attendanceRecordStatusSchema>;
export type AttendanceDayStatus = z.infer<typeof attendanceDayStatusSchema>;
export type AttendanceTeamDay = z.infer<typeof attendanceTeamDaySchema>;
export type AttendanceTeamDayQuery = z.infer<typeof attendanceTeamDayQuerySchema>;
export type AttendanceEventKind = z.infer<typeof attendanceEventKindSchema>;
export type GeofenceResult = z.infer<typeof geofenceResultSchema>;
export type AttendanceReviewStatus = z.infer<typeof attendanceReviewStatusSchema>;
export type AttendanceAdjustmentReason = z.infer<typeof attendanceAdjustmentReasonSchema>;
export type AttendanceAccuracyAction = z.infer<typeof attendanceAccuracyActionSchema>;
export type AttendanceCorrectionStatus = z.infer<typeof attendanceCorrectionStatusSchema>;
export type AttendanceLocationInput = z.infer<typeof attendanceLocationInputSchema>;
export type AttendanceCheckRequest = z.infer<typeof attendanceCheckRequestSchema>;
export type AttendanceRecord = z.infer<typeof attendanceRecordSchema>;
export type AttendanceEvent = z.infer<typeof attendanceEventSchema>;
export type AttendanceRecordDetail = z.infer<typeof attendanceRecordDetailSchema>;
export type AttendanceToday = z.infer<typeof attendanceTodaySchema>;
export type AttendanceCheckResult = z.infer<typeof attendanceCheckResultSchema>;
export type MyAttendanceQuery = z.infer<typeof myAttendanceQuerySchema>;
export type TeamAttendanceQuery = z.infer<typeof teamAttendanceQuerySchema>;
export type AttendanceExportQuery = z.infer<typeof attendanceExportQuerySchema>;
export type AttendanceReviewItem = z.infer<typeof attendanceReviewItemSchema>;
export type AttendanceReviewQuery = z.infer<typeof attendanceReviewQuerySchema>;
export type AttendanceReviewRequest = z.infer<typeof attendanceReviewRequestSchema>;
export type CreateAttendanceCorrectionRequest = z.infer<typeof createAttendanceCorrectionSchema>;
export type AttendanceCorrection = z.infer<typeof attendanceCorrectionSchema>;
export type AttendanceCorrectionQuery = z.infer<typeof attendanceCorrectionQuerySchema>;
export type AdminAttendanceCorrectionRequest = z.infer<typeof adminAttendanceCorrectionSchema>;
export type AttendancePolicy = z.infer<typeof attendancePolicySchema>;
export type SetAttendancePolicyRequest = z.infer<typeof setAttendancePolicySchema>;
export type Shift = z.infer<typeof shiftSchema>;
export type ShiftListQuery = z.infer<typeof shiftListQuerySchema>;
export type CreateShiftRequest = z.infer<typeof createShiftSchema>;
export type UpdateShiftRequest = z.infer<typeof updateShiftSchema>;
export type ShiftAssignment = z.infer<typeof shiftAssignmentSchema>;
export type ShiftAssignmentQuery = z.infer<typeof shiftAssignmentQuerySchema>;
export type CreateShiftAssignmentRequest = z.infer<typeof createShiftAssignmentSchema>;
export type EndShiftAssignmentRequest = z.infer<typeof endShiftAssignmentSchema>;
