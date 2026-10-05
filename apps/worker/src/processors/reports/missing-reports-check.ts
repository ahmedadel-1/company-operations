import { organizationsRequiringDailyReports } from '@company-ops/core';
import type { AsyncLocalTenantContext, DailyReportMissingCheck, PrismaClient } from '@company-ops/core';

export const MISSING_REPORTS_CHECK_JOB = 'daily-report.missing.check';
export const MISSING_REPORTS_CHECK_EVERY_MS = 15 * 60_000;

/**
 * Notifies reporters and project managers about missing daily reports (derived, never stored).
 * The organization scan is cross-tenant (system maintenance); each organization is checked in a
 * system tenant context of its own. Re-running is harmless: notifications are deduplicated.
 */
export async function checkMissingReports(
  deps: {
    readonly prisma: PrismaClient;
    readonly tenant: AsyncLocalTenantContext;
    readonly check: DailyReportMissingCheck;
  },
  now: Date,
): Promise<{ organizations: number; projects: number; notifications: number }> {
  let projects = 0;
  let notifications = 0;
  const organizations = await organizationsRequiringDailyReports(deps.prisma);
  for (const organizationId of organizations) {
    const result = await deps.tenant.run({ organizationId, memberId: null, userId: null }, () => deps.check.run(now));
    projects += result.projects;
    notifications += result.notifications;
  }
  return { organizations: organizations.length, projects, notifications };
}
