import type { Prisma } from '@company-ops/db';

import { localToday } from '../modules/projects/business-date.js';
import { recordAudit } from '../platform/audit/audit-writer.js';

/**
 * Development attendance configuration (ADR-0022): the accuracy policy (100 m, low accuracy flagged for
 * review, missing location rejected), a day shift (09:00–17:00) and an overnight shift (22:00–06:00) on
 * the organization's work week, and a day-shift assignment from today for every active employee without
 * one. Idempotent: existing policy, shifts and assignments are never changed.
 */
export async function seedAttendance(
  tx: Prisma.TransactionClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<{ shiftsCreated: number; assignmentsCreated: number }> {
  const organization = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { timeZone: true, workWeek: true },
  });
  const policy = await tx.attendancePolicy.findFirst({ where: { organizationId }, select: { id: true } });
  if (policy === null) {
    const created = await tx.attendancePolicy.create({
      data: {
        organizationId,
        maxAccuracyMeters: 100,
        lowAccuracyAction: 'FLAG_FOR_REVIEW',
        missingLocationAction: 'REJECT',
        missingCheckoutAfterMinutes: 240,
      },
      select: { id: true },
    });
    await recordAudit(tx, organizationId, {
      action: 'attendance.policy.created',
      entityType: 'attendance_policy',
      entityId: created.id,
      actor: { type: 'SYSTEM' },
      metadata: { source: 'dev-seed', maxAccuracyMeters: 100, lowAccuracyAction: 'FLAG_FOR_REVIEW' },
    });
  }

  const weekdays = [...organization.workWeek].sort((a, b) => a - b);
  const shifts = [
    { name: 'Day shift', startMinute: 9 * 60, endMinute: 17 * 60, grace: 15 },
    { name: 'Night shift', startMinute: 22 * 60, endMinute: 6 * 60, grace: 10 },
  ];
  const shiftIds = new Map<string, string>();
  let shiftsCreated = 0;
  for (const shift of shifts) {
    let row = await tx.shift.findFirst({ where: { organizationId, name: shift.name }, select: { id: true } });
    if (row === null) {
      row = await tx.shift.create({
        data: {
          organizationId,
          name: shift.name,
          startMinute: shift.startMinute,
          endMinute: shift.endMinute,
          crossesMidnight: shift.endMinute < shift.startMinute,
          lateGraceMinutes: shift.grace,
          earlyLeaveGraceMinutes: shift.grace,
          weekdays,
        },
        select: { id: true },
      });
      shiftsCreated += 1;
      await recordAudit(tx, organizationId, {
        action: 'attendance.shift.created',
        entityType: 'shift',
        entityId: row.id,
        actor: { type: 'SYSTEM' },
        metadata: { source: 'dev-seed', name: shift.name },
      });
    }
    shiftIds.set(shift.name, row.id);
  }

  const dayShiftId = shiftIds.get('Day shift');
  if (dayShiftId === undefined) throw new Error('The seeded day shift is missing.');
  const today = new Date(`${localToday(now, organization.timeZone)}T00:00:00.000Z`);
  const unassigned = await tx.employeeProfile.findMany({
    where: { organizationId, employmentStatus: 'ACTIVE', shiftAssignments: { none: {} } },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const profile of unassigned) {
    await tx.employeeShiftAssignment.create({
      data: { organizationId, profileId: profile.id, shiftId: dayShiftId, effectiveFrom: today },
    });
  }
  if (unassigned.length > 0) {
    await recordAudit(tx, organizationId, {
      action: 'attendance.shift_assignment.created',
      entityType: 'shift',
      entityId: dayShiftId,
      actor: { type: 'SYSTEM' },
      metadata: { source: 'dev-seed', count: unassigned.length },
    });
  }
  return { shiftsCreated, assignmentsCreated: unassigned.length };
}
