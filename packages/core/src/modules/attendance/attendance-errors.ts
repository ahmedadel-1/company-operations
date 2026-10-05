import { ERROR_CODES } from '@company-ops/shared';
import type { ErrorCode } from '@company-ops/shared';

import { DomainError } from '../../platform/errors.js';

type AttendanceCode =
  | typeof ERROR_CODES.ATTENDANCE_NOT_CONFIGURED
  | typeof ERROR_CODES.ATTENDANCE_NOT_ELIGIBLE
  | typeof ERROR_CODES.ATTENDANCE_OUTSIDE_GEOFENCE
  | typeof ERROR_CODES.ATTENDANCE_LOW_ACCURACY
  | typeof ERROR_CODES.ATTENDANCE_LOCATION_REQUIRED
  | typeof ERROR_CODES.ATTENDANCE_NO_LOCATION
  | typeof ERROR_CODES.ATTENDANCE_ALREADY_CHECKED_IN
  | typeof ERROR_CODES.ATTENDANCE_NOT_CHECKED_IN
  | typeof ERROR_CODES.ATTENDANCE_ALREADY_CHECKED_OUT
  | typeof ERROR_CODES.ATTENDANCE_ON_LEAVE;

const STATUS: Readonly<Record<AttendanceCode, number>> = {
  ATTENDANCE_NOT_CONFIGURED: 409,
  ATTENDANCE_NOT_ELIGIBLE: 409,
  ATTENDANCE_OUTSIDE_GEOFENCE: 422,
  ATTENDANCE_LOW_ACCURACY: 422,
  ATTENDANCE_LOCATION_REQUIRED: 422,
  ATTENDANCE_NO_LOCATION: 422,
  ATTENDANCE_ALREADY_CHECKED_IN: 409,
  ATTENDANCE_NOT_CHECKED_IN: 409,
  ATTENDANCE_ALREADY_CHECKED_OUT: 409,
  ATTENDANCE_ON_LEAVE: 409,
};

const MESSAGES: Readonly<Record<AttendanceCode, string>> = {
  ATTENDANCE_NOT_CONFIGURED:
    'Attendance is not configured yet. An administrator must set the location accuracy policy.',
  ATTENDANCE_NOT_ELIGIBLE: 'Your account cannot record attendance. Contact HR.',
  ATTENDANCE_OUTSIDE_GEOFENCE: 'You are outside the allowed area of your work locations.',
  ATTENDANCE_LOW_ACCURACY: 'The location accuracy is too low. Move to an open area and try again.',
  ATTENDANCE_LOCATION_REQUIRED: 'A location is required to record attendance. Allow location access and try again.',
  ATTENDANCE_NO_LOCATION: 'No active work location is available for you. Contact HR.',
  ATTENDANCE_ALREADY_CHECKED_IN: 'You have already checked in for this work day.',
  ATTENDANCE_NOT_CHECKED_IN: 'You have not checked in for this work day.',
  ATTENDANCE_ALREADY_CHECKED_OUT: 'You have already checked out for this work day.',
  ATTENDANCE_ON_LEAVE: 'An approved leave covers this day.',
};

/** Attendance rule violations with stable codes (409 state conflicts, 422 evidence refused). */
export class AttendanceError extends DomainError {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(code: AttendanceCode, details?: Readonly<Record<string, unknown>>) {
    super(MESSAGES[code], details);
    this.status = STATUS[code];
    this.code = code;
  }
}
