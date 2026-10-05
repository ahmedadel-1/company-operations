import { lockAttendanceProfile } from '../../platform/db/sql/attendance.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { addDays, fromDateOnly, localToday, toDateOnly } from '../projects/business-date.js';
import { DEFAULT_MISSING_CHECKOUT_MINUTES, loadPolicy, organizationZone, rederiveRecord } from './attendance-store.js';
import { missingCheckoutDeadline } from './engine/time.js';

/** Records examined per organization and pass; the rest is picked up by the next pass. */
export const SWEEP_BATCH = 500;

export interface SweepResult {
  readonly flagged: number;
  readonly closedDays: number;
}

/**
 * Missing-checkout handling (ADR-0022), run per organization in a system tenant context:
 * - OPEN records whose deadline (scheduled end, or the end of the local day, plus the policy's grace)
 *   has passed get one `SYSTEM_MISSING_CHECKOUT` event and become `MISSING_CHECKOUT`. No check-out time
 *   is invented. The employee gets one in-app notification (deduplicated per record), no email.
 * - SCHEDULED records of days that are over are re-derived, which turns them into `ABSENT` (or
 *   `EXCUSED` when an effect covers them). Future and current days are never absent.
 * Bounded and idempotent: deterministic event keys and conditional checks under the employee lock.
 */
export class MissingCheckoutSweep {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async run(now: Date): Promise<SweepResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const policy = await loadPolicy(this.db, organizationId);
    const grace = policy?.missingCheckoutAfterMinutes ?? DEFAULT_MISSING_CHECKOUT_MINUTES;
    // Zones differ per employee (at most a day apart); each candidate's own deadline decides.
    const latest = addDays(localToday(now, await organizationZone(this.db, organizationId)), 1);
    const open = await this.db.attendanceRecord.findMany({
      where: { organizationId, status: 'OPEN', workDate: { lte: fromDateOnly(latest) } },
      orderBy: [{ workDate: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH,
      select: {
        id: true,
        profileId: true,
        memberId: true,
        workDate: true,
        timeZone: true,
        scheduledEndAt: true,
        checkInAt: true,
      },
    });
    let flagged = 0;
    for (const candidate of open) {
      const workDate = toDateOnly(candidate.workDate) ?? '';
      const deadline = missingCheckoutDeadline(
        workDate,
        candidate.timeZone,
        candidate.scheduledEndAt,
        grace,
        candidate.checkInAt,
      );
      if (deadline.getTime() > now.getTime()) continue;
      const done = await this.db.$transaction(async (tx) => {
        await lockAttendanceProfile(tx, organizationId, candidate.profileId);
        const current = await tx.attendanceRecord.findFirst({
          where: { organizationId, id: candidate.id, status: 'OPEN' },
          select: { id: true },
        });
        if (current === null) return false;
        const key = `missing:${candidate.id}`;
        const exists = await tx.attendanceEvent.findFirst({
          where: { organizationId, idempotencyKey: key },
          select: { id: true },
        });
        if (exists !== null) return false;
        await tx.attendanceEvent.create({
          data: {
            organizationId,
            recordId: candidate.id,
            profileId: candidate.profileId,
            kind: 'SYSTEM_MISSING_CHECKOUT',
            recordedAt: now,
            workDate: candidate.workDate,
            idempotencyKey: key,
          },
          select: { id: true },
        });
        await rederiveRecord(tx, organizationId, candidate.id, now);
        await enqueueOutboxEvent(tx, organizationId, {
          eventType: 'notification.requested',
          aggregateType: 'attendance_record',
          aggregateId: candidate.id,
          payload: {
            recipientMemberId: candidate.memberId,
            type: 'ATTENDANCE_MISSING_CHECKOUT',
            severity: 'WARNING',
            entityType: 'attendance_record',
            entityId: candidate.id,
            params: { date: workDate },
            dedupeKey: `attendance-missing:${candidate.id}`,
          },
        });
        return true;
      });
      if (done) flagged += 1;
    }

    const scheduled = await this.db.attendanceRecord.findMany({
      where: { organizationId, status: 'SCHEDULED', workDate: { lt: fromDateOnly(latest) } },
      orderBy: [{ workDate: 'asc' }, { id: 'asc' }],
      take: SWEEP_BATCH,
      select: { id: true, profileId: true, workDate: true, timeZone: true },
    });
    let closedDays = 0;
    for (const candidate of scheduled) {
      if ((toDateOnly(candidate.workDate) ?? '') >= localToday(now, candidate.timeZone)) continue;
      await this.db.$transaction(async (tx) => {
        await lockAttendanceProfile(tx, organizationId, candidate.profileId);
        await rederiveRecord(tx, organizationId, candidate.id, now);
      });
      closedDays += 1;
    }
    return { flagged, closedDays };
  }
}
