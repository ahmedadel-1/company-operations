import { MissingCheckoutSweep, organizationsWithOpenAttendance } from '@company-ops/core';
import type {
  AsyncLocalTenantContext,
  DashboardInvalidator,
  PrismaClient,
  TenantScopedClient,
} from '@company-ops/core';

export const ATTENDANCE_SWEEP_JOB = 'attendance.missing-checkout.sweep';

const DAY_MS = 86_400_000;

export interface AttendanceSweepTotals {
  readonly organizations: number;
  readonly flagged: number;
  readonly closedDays: number;
  readonly failedOrganizations: number;
}

/**
 * Missing check-out handling for every organization with open or scheduled attendance days (ADR-0022).
 * The organization scan is cross-tenant (system maintenance) and bounded by the latest work date any
 * time zone can have reached; each organization runs in its own system tenant context, and one failing
 * organization does not stop the others. Re-running is harmless: each record gets at most one
 * `SYSTEM_MISSING_CHECKOUT` event and one notification, and no check-out time is ever invented.
 */
export async function sweepAttendance(
  deps: {
    readonly prisma: PrismaClient;
    readonly db: TenantScopedClient;
    readonly tenant: AsyncLocalTenantContext;
    readonly onOrganizationError: (organizationId: string, error: unknown) => void;
    readonly invalidate?: DashboardInvalidator;
  },
  now: Date,
): Promise<AttendanceSweepTotals> {
  const latestWorkDate = new Date(now.getTime() + DAY_MS).toISOString().slice(0, 10);
  const organizations = await organizationsWithOpenAttendance(deps.prisma, latestWorkDate);
  const sweep = new MissingCheckoutSweep(deps.db, deps.tenant);
  let flagged = 0;
  let closedDays = 0;
  let failedOrganizations = 0;
  for (const organizationId of organizations) {
    try {
      const result = await deps.tenant.run({ organizationId, memberId: null, userId: null }, () => sweep.run(now));
      flagged += result.flagged;
      closedDays += result.closedDays;
      if (result.flagged > 0 || result.closedDays > 0) {
        await deps.invalidate?.(organizationId, ['attendance']);
      }
    } catch (error) {
      failedOrganizations += 1;
      deps.onOrganizationError(organizationId, error);
    }
  }
  return { organizations: organizations.length, flagged, closedDays, failedOrganizations };
}
