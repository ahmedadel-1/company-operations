import type { Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isExclusionViolation, isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { lockAttendanceProfile } from '../../platform/db/sql/attendance.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { addDays, fromDateOnly, localToday, toDateOnly } from '../projects/business-date.js';
import { holdsOrgWide } from '../projects/project-access.js';
import { organizationZone, toEmployeeRef } from './attendance-store.js';
import type { EmployeeRefView } from './attendance-store.js';
import { formatMinutes, parseLocalTime } from './engine/time.js';

export interface ShiftView {
  readonly id: string;
  readonly name: string;
  readonly start: string;
  readonly end: string;
  readonly crossesMidnight: boolean;
  readonly lateGraceMinutes: number;
  readonly earlyLeaveGraceMinutes: number;
  readonly weekdays: readonly number[];
  readonly active: boolean;
  readonly activeAssignments: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateShiftInput {
  readonly name: string;
  readonly start: string;
  readonly end: string;
  readonly lateGraceMinutes: number;
  readonly earlyLeaveGraceMinutes: number;
  readonly weekdays: readonly number[];
  readonly active?: boolean | undefined;
}

export interface UpdateShiftInput {
  readonly name?: string | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
  readonly lateGraceMinutes?: number | undefined;
  readonly earlyLeaveGraceMinutes?: number | undefined;
  readonly weekdays?: readonly number[] | undefined;
  readonly active?: boolean | undefined;
  readonly version: number;
}

export interface ShiftAssignmentView {
  readonly id: string;
  readonly employee: EmployeeRefView;
  readonly shift: { readonly id: string; readonly name: string };
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly version: number;
  readonly createdAt: string;
}

export interface AssignmentQuery {
  readonly profileId?: string | undefined;
  readonly shiftId?: string | undefined;
  readonly activeOn?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const shiftSelect = {
  id: true,
  name: true,
  startMinute: true,
  endMinute: true,
  crossesMidnight: true,
  lateGraceMinutes: true,
  earlyLeaveGraceMinutes: true,
  weekdays: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ShiftSelect;

type ShiftRow = Prisma.ShiftGetPayload<{ select: typeof shiftSelect }>;

const assignmentSelect = {
  id: true,
  profileId: true,
  effectiveFrom: true,
  effectiveTo: true,
  version: true,
  createdAt: true,
  profile: {
    select: {
      id: true,
      memberId: true,
      fullName: true,
      employeeNumber: true,
      department: { select: { id: true, name: true } },
    },
  },
  shift: { select: { id: true, name: true } },
} satisfies Prisma.EmployeeShiftAssignmentSelect;

type AssignmentRow = Prisma.EmployeeShiftAssignmentGetPayload<{ select: typeof assignmentSelect }>;

const toAssignmentView = (row: AssignmentRow): ShiftAssignmentView => ({
  id: row.id,
  employee: toEmployeeRef(row.profile),
  shift: row.shift,
  effectiveFrom: toDateOnly(row.effectiveFrom) ?? '',
  effectiveTo: toDateOnly(row.effectiveTo),
  version: row.version,
  createdAt: row.createdAt.toISOString(),
});

const sortedWeekdays = (days: readonly number[]): number[] => [...new Set(days)].sort((a, b) => a - b);

/** A shift window from local times; start = end is rejected, end < start crosses midnight. */
function window(start: string, end: string): { startMinute: number; endMinute: number; crossesMidnight: boolean } {
  const startMinute = parseLocalTime(start);
  const endMinute = parseLocalTime(end);
  if (startMinute === endMinute) throw new InvalidInputError('end', 'The shift start and end must differ.');
  return { startMinute, endMinute, crossesMidnight: endMinute < startMinute };
}

/**
 * Shifts and shift assignments (ADR-0022), `attendance.config` at organization scope. Shifts are
 * deactivated, never deleted; assignments are ended, never deleted, and may not overlap (service check
 * under the employee's attendance lock, backed by a GiST exclusion constraint). Records keep the shift
 * snapshot they were created with, so edits never rewrite history. Every change is audited.
 */
export class ShiftService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async listShifts(action: ActionContext, includeInactive: boolean): Promise<ShiftView[]> {
    const organizationId = this.authorize(action);
    const rows = await this.db.shift.findMany({
      where: { organizationId, ...(includeInactive ? {} : { active: true }) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: 200,
      select: shiftSelect,
    });
    return this.shiftViews(organizationId, rows);
  }

  async createShift(action: ActionContext, input: CreateShiftInput): Promise<ShiftView> {
    const organizationId = this.authorize(action);
    const times = window(input.start, input.end);
    try {
      return await this.db.$transaction(async (tx) => {
        const created = await tx.shift.create({
          data: {
            organizationId,
            name: input.name,
            ...times,
            lateGraceMinutes: input.lateGraceMinutes,
            earlyLeaveGraceMinutes: input.earlyLeaveGraceMinutes,
            weekdays: sortedWeekdays(input.weekdays),
            active: input.active ?? true,
          },
          select: shiftSelect,
        });
        await recordAudit(tx, organizationId, {
          action: 'attendance.shift.created',
          entityType: 'shift',
          entityId: created.id,
          actor: userActor(action),
          metadata: { after: this.auditShape(created) },
          context: action.request,
        });
        const [view] = await this.shiftViews(organizationId, [created], tx);
        if (view === undefined) throw new Error('Created shift is missing.');
        return view;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A shift with this name already exists.');
      throw error;
    }
  }

  async updateShift(action: ActionContext, shiftId: string, input: UpdateShiftInput): Promise<ShiftView> {
    const organizationId = this.authorize(action);
    try {
      return await this.db.$transaction(async (tx) => {
        const current = await tx.shift.findFirst({ where: { organizationId, id: shiftId }, select: shiftSelect });
        if (current === null) throw new NotFoundError('Shift');
        const times =
          input.start === undefined && input.end === undefined
            ? {}
            : window(input.start ?? formatMinutes(current.startMinute), input.end ?? formatMinutes(current.endMinute));
        const updated = await tx.shift.updateMany({
          where: { organizationId, id: shiftId, version: input.version },
          data: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...times,
            ...(input.lateGraceMinutes === undefined ? {} : { lateGraceMinutes: input.lateGraceMinutes }),
            ...(input.earlyLeaveGraceMinutes === undefined
              ? {}
              : { earlyLeaveGraceMinutes: input.earlyLeaveGraceMinutes }),
            ...(input.weekdays === undefined ? {} : { weekdays: sortedWeekdays(input.weekdays) }),
            ...(input.active === undefined ? {} : { active: input.active }),
            version: { increment: 1 },
          },
        });
        if (updated.count === 0) throw new VersionConflictError('Shift');
        const after = await tx.shift.findFirstOrThrow({ where: { organizationId, id: shiftId }, select: shiftSelect });
        await recordAudit(tx, organizationId, {
          action:
            input.active !== undefined && input.active !== current.active
              ? input.active
                ? 'attendance.shift.activated'
                : 'attendance.shift.deactivated'
              : 'attendance.shift.updated',
          entityType: 'shift',
          entityId: shiftId,
          actor: userActor(action),
          metadata: { before: this.auditShape(current), after: this.auditShape(after) },
          context: action.request,
        });
        const [view] = await this.shiftViews(organizationId, [after], tx);
        if (view === undefined) throw new Error('Updated shift is missing.');
        return view;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('A shift with this name already exists.');
      throw error;
    }
  }

  async listAssignments(action: ActionContext, query: AssignmentQuery): Promise<Page<ShiftAssignmentView>> {
    const organizationId = this.authorize(action);
    const size = pageSize(query.limit);
    const and: Prisma.EmployeeShiftAssignmentWhereInput[] = [];
    if (query.profileId !== undefined) and.push({ profileId: query.profileId });
    if (query.shiftId !== undefined) and.push({ shiftId: query.shiftId });
    if (query.activeOn !== undefined) {
      const day = fromDateOnly(query.activeOn);
      and.push({ effectiveFrom: { lte: day }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }] });
    }
    if (query.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(query.cursor, 2);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InvalidInputError('cursor', 'The cursor is invalid.');
      const key = fromDateOnly(value);
      and.push({ OR: [{ effectiveFrom: { lt: key } }, { effectiveFrom: key, id: { lt: id } }] });
    }
    const rows = await this.db.employeeShiftAssignment.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      take: size + 1,
      select: assignmentSelect,
    });
    const page = toPage(rows, size, (row) => [toDateOnly(row.effectiveFrom) ?? '', row.id]);
    return { items: page.items.map(toAssignmentView), nextCursor: page.nextCursor };
  }

  /** Assigns an active shift from today or later; overlapping an existing assignment is 409. */
  async createAssignment(
    action: ActionContext,
    input: { profileId: string; shiftId: string; effectiveFrom: string; effectiveTo?: string | null | undefined },
  ): Promise<ShiftAssignmentView> {
    const organizationId = this.authorize(action);
    const today = localToday(this.clock(), await organizationZone(this.db, organizationId));
    if (input.effectiveFrom < today) {
      throw new InvalidInputError('effectiveFrom', 'An assignment cannot start in the past.');
    }
    const effectiveTo = input.effectiveTo ?? null;
    if (effectiveTo !== null && effectiveTo < input.effectiveFrom) {
      throw new InvalidInputError('effectiveTo', 'The end date must not be before the start date.');
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const profile = await tx.employeeProfile.findFirst({
          where: { organizationId, id: input.profileId },
          select: { id: true, employmentStatus: true },
        });
        if (profile === null) throw new InvalidInputError('profileId', 'Unknown employee.');
        if (profile.employmentStatus === 'TERMINATED') {
          throw new InvalidInputError('profileId', 'The employee is no longer employed.');
        }
        const shift = await tx.shift.findFirst({
          where: { organizationId, id: input.shiftId },
          select: { id: true, active: true },
        });
        if (shift === null) throw new InvalidInputError('shiftId', 'Unknown shift.');
        if (!shift.active) throw new InvalidInputError('shiftId', 'The shift is inactive.');
        await lockAttendanceProfile(tx, organizationId, profile.id);
        await this.assertNoOverlap(tx, organizationId, profile.id, input.effectiveFrom, effectiveTo, null);
        const created = await tx.employeeShiftAssignment.create({
          data: {
            organizationId,
            profileId: profile.id,
            shiftId: shift.id,
            effectiveFrom: fromDateOnly(input.effectiveFrom),
            effectiveTo: effectiveTo === null ? null : fromDateOnly(effectiveTo),
            createdByMemberId: action.principal.memberId,
          },
          select: assignmentSelect,
        });
        await recordAudit(tx, organizationId, {
          action: 'attendance.shift_assignment.created',
          entityType: 'shift_assignment',
          entityId: created.id,
          actor: userActor(action),
          metadata: {
            profileId: profile.id,
            shiftId: shift.id,
            effectiveFrom: input.effectiveFrom,
            effectiveTo,
          },
          context: action.request,
        });
        return toAssignmentView(created);
      });
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw new ConflictError('The employee already has a shift assignment in this period.');
      }
      throw error;
    }
  }

  /**
   * Ends an assignment on `effectiveTo` (inclusive). Past days keep their shift: the end can be no
   * earlier than yesterday, and never before the assignment starts.
   */
  async endAssignment(
    action: ActionContext,
    assignmentId: string,
    input: { effectiveTo: string; version: number },
  ): Promise<ShiftAssignmentView> {
    const organizationId = this.authorize(action);
    const today = localToday(this.clock(), await organizationZone(this.db, organizationId));
    try {
      return await this.db.$transaction(async (tx) => {
        const current = await tx.employeeShiftAssignment.findFirst({
          where: { organizationId, id: assignmentId },
          select: assignmentSelect,
        });
        if (current === null) throw new NotFoundError('Shift assignment');
        const from = toDateOnly(current.effectiveFrom) ?? '';
        const previousTo = toDateOnly(current.effectiveTo);
        if (input.effectiveTo < from) {
          throw new InvalidInputError('effectiveTo', 'The end date must not be before the start date.');
        }
        if (input.effectiveTo < addDays(today, -1)) {
          throw new InvalidInputError('effectiveTo', 'An assignment cannot be ended before yesterday.');
        }
        if (previousTo !== null && previousTo < addDays(today, -1)) {
          throw new InvalidInputError('effectiveTo', 'This assignment has already ended.');
        }
        await lockAttendanceProfile(tx, organizationId, current.profileId);
        await this.assertNoOverlap(tx, organizationId, current.profileId, from, input.effectiveTo, assignmentId);
        const updated = await tx.employeeShiftAssignment.updateMany({
          where: { organizationId, id: assignmentId, version: input.version },
          data: { effectiveTo: fromDateOnly(input.effectiveTo), version: { increment: 1 } },
        });
        if (updated.count === 0) throw new VersionConflictError('Shift assignment');
        await recordAudit(tx, organizationId, {
          action: 'attendance.shift_assignment.ended',
          entityType: 'shift_assignment',
          entityId: assignmentId,
          actor: userActor(action),
          metadata: {
            profileId: current.profileId,
            shiftId: current.shift.id,
            before: { effectiveTo: previousTo },
            after: { effectiveTo: input.effectiveTo },
          },
          context: action.request,
        });
        return toAssignmentView(
          await tx.employeeShiftAssignment.findFirstOrThrow({
            where: { organizationId, id: assignmentId },
            select: assignmentSelect,
          }),
        );
      });
    } catch (error) {
      if (isExclusionViolation(error)) {
        throw new ConflictError('The employee already has a shift assignment in this period.');
      }
      throw error;
    }
  }

  // ---- internals ----

  private authorize(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'attendance.config')) throw new ForbiddenError();
    return organizationId;
  }

  private async assertNoOverlap(
    db: TenantDb,
    organizationId: string,
    profileId: string,
    from: string,
    to: string | null,
    excludeId: string | null,
  ): Promise<void> {
    const overlapping = await db.employeeShiftAssignment.findFirst({
      where: {
        organizationId,
        profileId,
        ...(excludeId === null ? {} : { id: { not: excludeId } }),
        ...(to === null ? {} : { effectiveFrom: { lte: fromDateOnly(to) } }),
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: fromDateOnly(from) } }],
      },
      select: { id: true },
    });
    if (overlapping !== null) {
      throw new ConflictError('The employee already has a shift assignment in this period.');
    }
  }

  private async shiftViews(
    organizationId: string,
    rows: readonly ShiftRow[],
    db: TenantDb = this.db,
  ): Promise<ShiftView[]> {
    const today = fromDateOnly(localToday(this.clock(), await organizationZone(db, organizationId)));
    const counts = await db.employeeShiftAssignment.groupBy({
      by: ['shiftId'],
      where: {
        organizationId,
        shiftId: { in: rows.map((row) => row.id) },
        effectiveFrom: { lte: today },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }],
      },
      _count: { _all: true },
    });
    const byShift = new Map(counts.map((row) => [row.shiftId, row._count._all]));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      start: formatMinutes(row.startMinute),
      end: formatMinutes(row.endMinute),
      crossesMidnight: row.crossesMidnight,
      lateGraceMinutes: row.lateGraceMinutes,
      earlyLeaveGraceMinutes: row.earlyLeaveGraceMinutes,
      weekdays: row.weekdays,
      active: row.active,
      activeAssignments: byShift.get(row.id) ?? 0,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  private auditShape(row: ShiftRow): Record<string, unknown> {
    return {
      name: row.name,
      start: formatMinutes(row.startMinute),
      end: formatMinutes(row.endMinute),
      lateGraceMinutes: row.lateGraceMinutes,
      earlyLeaveGraceMinutes: row.earlyLeaveGraceMinutes,
      weekdays: row.weekdays,
      active: row.active,
    };
  }
}
