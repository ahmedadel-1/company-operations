-- Phase 7 attendance (ADR-0022): enum types first, in their own migration, so that the values added
-- to existing enums are committed before the next migration uses them in constraints.

-- CreateEnum
CREATE TYPE "AttendanceAccuracyAction" AS ENUM ('FLAG_FOR_REVIEW', 'REJECT');

-- CreateEnum
CREATE TYPE "AttendanceMode" AS ENUM ('OFFICE', 'SITE', 'REMOTE', 'BUSINESS_MISSION', 'LEAVE');

-- CreateEnum
CREATE TYPE "AttendanceRecordStatus" AS ENUM ('OPEN', 'COMPLETE', 'MISSING_CHECKOUT', 'EXCUSED', 'ABSENT', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "AttendanceEventKind" AS ENUM ('CHECK_IN', 'CHECK_OUT', 'ADJUSTED', 'ADJUSTMENT_REVERTED', 'SYSTEM_MISSING_CHECKOUT', 'EFFECT_APPLIED', 'EFFECT_REVOKED');

-- CreateEnum
CREATE TYPE "AttendanceGeofenceResult" AS ENUM ('INSIDE', 'OUTSIDE', 'LOW_ACCURACY', 'NOT_REQUIRED', 'PERMISSION_DENIED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AttendanceReviewStatus" AS ENUM ('NOT_REQUIRED', 'PENDING_REVIEW', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AttendanceAdjustmentReason" AS ENUM ('FORGOT_CHECK_IN', 'FORGOT_CHECK_OUT', 'WRONG_LOCATION', 'SYSTEM_ISSUE', 'INCORRECT_TIME');

-- AlterEnum
ALTER TYPE "RequestEffectMode" ADD VALUE 'CORRECTION';

-- AlterEnum
ALTER TYPE "RetentionAction" ADD VALUE 'NULL_COORDINATES';

-- AlterEnum
ALTER TYPE "RetentionCategory" ADD VALUE 'ATTENDANCE_COORDINATES';

