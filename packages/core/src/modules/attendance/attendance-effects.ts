import { lockAttendanceProfile } from '../../platform/db/sql/attendance.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { addDays, fromDateOnly, localToday, toDateOnly } from '../projects/business-date.js';
import {
  assignedShifts,
  attendanceZone,
  ensureRecord,
  findRecord,
  loadEmployeeByMember,
  rederiveRecord,
  runningShifts,
} from './attendance-store.js';
import type { EmployeeRow, RecordRow } from './attendance-store.js';
import type { AttendanceMode } from './engine/derive.js';

/** A job that can never succeed (unknown effect, foreign organization, inconsistent data). */
export class AttendanceJobRejectedError extends Error {
  override readonly name = 'AttendanceJobRejectedError';
}

export type EffectSignal = 'RECORDED' | 'REVOKED';

export interface EffectJobResult {
  readonly effectId: string;
  readonly outcome: 'APPLIED' | 'REVERTED' | 'SKIPPED';
  readonly dates: number;
}

/** Effect materialization covers at most this many days (ADR-0022); later days derive from effects. */
export const MAX_MATERIALIZED_DAYS = 62;

const MODE_OF_EFFECT: Readonly<Record<string, AttendanceMode | null>> = {
  LEAVE: 'LEAVE',
  BUSINESS_MISSION: 'BUSINESS_MISSION',
  REMOTE: 'REMOTE',
  SHORT_LEAVE: null,
};

/**
 * Worker-side consumer of trusted Phase 6 effects (ADR-0022), running in a system tenant context.
 * Leave, missions, remote work and short permissions are materialized on past and current dates as
 * `EFFECT_APPLIED` / `EFFECT_REVOKED` events (records are created only for leave and missions);
 * corrections apply the trusted adjustment row as `ADJUSTED` / `ADJUSTMENT_REVERTED`. Every system event
 * has a deterministic idempotency key, so re-delivery changes nothing.
 */
export class AttendanceEffectConsumer {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async handle(signal: EffectSignal, requestId: string, effectId: string, now: Date): Promise<EffectJobResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    return this.db.$transaction(async (tx) => {
      const effect = await tx.requestEffect.findFirst({
        where: { organizationId, id: effectId, requestId, kind: 'ATTENDANCE' },
        select: {
          id: true,
          mode: true,
          status: true,
          startsOn: true,
          endsOn: true,
          request: { select: { id: true, requesterMemberId: true, status: true } },
        },
      });
      if (effect === null) throw new AttendanceJobRejectedError('The effect does not exist in the event organization.');
      if (signal === 'RECORDED' && effect.status !== 'RECORDED') {
        // Revoked before this delivery: the revocation job owns the outcome.
        return { effectId, outcome: 'SKIPPED', dates: 0 };
      }
      if (signal === 'REVOKED' && effect.status !== 'REVOKED') {
        throw new AttendanceJobRejectedError('The effect has not been revoked.');
      }
      const employee = await loadEmployeeByMember(tx, organizationId, effect.request.requesterMemberId);
      if (employee === null) return { effectId, outcome: 'SKIPPED', dates: 0 };
      await lockAttendanceProfile(tx, organizationId, employee.id);
      const timeZone = await attendanceZone(tx, organizationId, employee);
      if (effect.mode === 'CORRECTION') {
        return this.correction(tx, organizationId, signal, effect.id, effect.request.id, employee, timeZone, now);
      }
      const startsOn = toDateOnly(effect.startsOn) ?? '';
      const endsOn = toDateOnly(effect.endsOn) ?? '';
      const today = localToday(now, timeZone);
      const last = [endsOn, today, addDays(startsOn, MAX_MATERIALIZED_DAYS - 1)].sort()[0] ?? startsOn;
      const createsRecords = effect.mode === 'LEAVE' || effect.mode === 'BUSINESS_MISSION';
      let dates = 0;
      for (let date = startsOn; date <= last; date = addDays(date, 1)) {
        const key = `effect:${effect.id}:${signal === 'RECORDED' ? 'applied' : 'revoked'}:${date}`;
        const record =
          signal === 'RECORDED' && createsRecords
            ? await this.recordFor(tx, organizationId, employee, date, timeZone)
            : await findRecord(tx, organizationId, employee.id, date);
        if (record === null) continue;
        if (await this.hasEvent(tx, organizationId, key)) continue;
        await tx.attendanceEvent.create({
          data: {
            organizationId,
            recordId: record.id,
            profileId: employee.id,
            kind: signal === 'RECORDED' ? 'EFFECT_APPLIED' : 'EFFECT_REVOKED',
            recordedAt: now,
            workDate: fromDateOnly(date),
            mode: MODE_OF_EFFECT[effect.mode] ?? null,
            requestId: effect.request.id,
            requestEffectId: effect.id,
            idempotencyKey: key,
          },
          select: { id: true },
        });
        await rederiveRecord(tx, organizationId, record.id, now);
        dates += 1;
      }
      return { effectId, outcome: signal === 'RECORDED' ? 'APPLIED' : 'REVERTED', dates };
    });
  }

  private async correction(
    tx: TenantDb,
    organizationId: string,
    signal: EffectSignal,
    effectId: string,
    requestId: string,
    employee: EmployeeRow,
    timeZone: string,
    now: Date,
  ): Promise<EffectJobResult> {
    const adjustment = await tx.attendanceAdjustmentRequest.findFirst({
      where: { organizationId, requestId },
      select: {
        id: true,
        profileId: true,
        workDate: true,
        reasonCode: true,
        requestedCheckInAt: true,
        requestedCheckOutAt: true,
        appliedAt: true,
        revertedAt: true,
        recordId: true,
      },
    });
    if (adjustment?.profileId !== employee.id) {
      throw new AttendanceJobRejectedError('The correction does not belong to the requester.');
    }
    const workDate = toDateOnly(adjustment.workDate) ?? '';
    if (signal === 'RECORDED') {
      if (adjustment.appliedAt !== null) return { effectId, outcome: 'SKIPPED', dates: 0 };
      const record = await this.recordFor(tx, organizationId, employee, workDate, timeZone);
      const approval = await tx.requestApproval.findFirst({
        where: { organizationId, requestId, status: 'APPROVED' },
        orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
        select: { approverMemberId: true, decidedByMemberId: true },
      });
      await tx.attendanceEvent.create({
        data: {
          organizationId,
          recordId: record.id,
          profileId: employee.id,
          kind: 'ADJUSTED',
          recordedAt: now,
          workDate: fromDateOnly(workDate),
          mode: record.mode ?? 'OFFICE',
          actorMemberId: approval?.decidedByMemberId ?? approval?.approverMemberId ?? null,
          requestId,
          requestEffectId: effectId,
          adjustmentId: adjustment.id,
          reasonCode: adjustment.reasonCode,
          previousCheckInAt: record.checkInAt,
          previousCheckOutAt: record.checkOutAt,
          adjustedCheckInAt: adjustment.requestedCheckInAt,
          adjustedCheckOutAt: adjustment.requestedCheckOutAt,
          idempotencyKey: `adjust:${adjustment.id}:applied`,
        },
        select: { id: true },
      });
      await tx.attendanceAdjustmentRequest.updateMany({
        where: { organizationId, id: adjustment.id, appliedAt: null },
        data: { appliedAt: now, ...(adjustment.recordId === null ? { recordId: record.id } : {}) },
      });
      await rederiveRecord(tx, organizationId, record.id, now);
      return { effectId, outcome: 'APPLIED', dates: 1 };
    }
    if (adjustment.appliedAt === null || adjustment.revertedAt !== null) {
      return { effectId, outcome: 'SKIPPED', dates: 0 };
    }
    const record = await findRecord(tx, organizationId, employee.id, workDate);
    if (record === null) throw new AttendanceJobRejectedError('The corrected record is missing.');
    const cancelled = await tx.requestEvent.findFirst({
      where: { organizationId, requestId, type: 'CANCELLED' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { actorMemberId: true },
    });
    await tx.attendanceEvent.create({
      data: {
        organizationId,
        recordId: record.id,
        profileId: employee.id,
        kind: 'ADJUSTMENT_REVERTED',
        recordedAt: now,
        workDate: fromDateOnly(workDate),
        mode: record.mode,
        actorMemberId: cancelled?.actorMemberId ?? null,
        requestId,
        requestEffectId: effectId,
        adjustmentId: adjustment.id,
        reasonCode: adjustment.reasonCode,
        idempotencyKey: `adjust:${adjustment.id}:reverted`,
      },
      select: { id: true },
    });
    await tx.attendanceAdjustmentRequest.updateMany({
      where: { organizationId, id: adjustment.id, revertedAt: null },
      data: { revertedAt: now },
    });
    await rederiveRecord(tx, organizationId, record.id, now);
    return { effectId, outcome: 'REVERTED', dates: 1 };
  }

  private async recordFor(
    tx: TenantDb,
    organizationId: string,
    employee: EmployeeRow,
    date: string,
    timeZone: string,
  ): Promise<RecordRow> {
    const existing = await findRecord(tx, organizationId, employee.id, date);
    if (existing !== null) return existing;
    const lookup = runningShifts(await assignedShifts(tx, organizationId, employee.id, date, date));
    return ensureRecord(tx, organizationId, employee, date, timeZone, lookup(date));
  }

  private async hasEvent(tx: TenantDb, organizationId: string, idempotencyKey: string): Promise<boolean> {
    const found = await tx.attendanceEvent.findFirst({
      where: { organizationId, idempotencyKey },
      select: { id: true },
    });
    return found !== null;
  }
}
