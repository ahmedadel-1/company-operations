import { CommercialMonitor, organizationsWithCommercialRecords } from '@company-ops/core';
import type {
  AsyncLocalTenantContext,
  DashboardInvalidator,
  PrismaClient,
  TenantScopedClient,
} from '@company-ops/core';

export const COMMERCIAL_MONITOR_JOB = 'commercial.monitor';

export interface CommercialMonitorTotals {
  readonly organizations: number;
  readonly reminders: number;
  readonly contractsExpired: number;
  readonly guaranteesExpired: number;
  readonly occurrencesGenerated: number;
  readonly contractsRefreshed: number;
  readonly failedOrganizations: number;
}

/**
 * The commercial monitor for every active organization holding commercial records (ADR-0026). The
 * organization scan is cross-tenant (system maintenance); each organization runs in its own system
 * tenant context and evaluates "today" in its own time zone, and one failing organization does not
 * stop the others. Re-running is harmless: every reminder is claimed once in `commercial_reminders`
 * and every state change is conditional.
 */
export async function runCommercialMonitor(
  deps: {
    readonly prisma: PrismaClient;
    readonly db: TenantScopedClient;
    readonly tenant: AsyncLocalTenantContext;
    readonly onOrganizationError: (organizationId: string, error: unknown) => void;
    readonly invalidate?: DashboardInvalidator;
  },
  now: Date,
): Promise<CommercialMonitorTotals> {
  const organizations = await organizationsWithCommercialRecords(deps.prisma);
  const monitor = new CommercialMonitor(deps.db, deps.tenant);
  let reminders = 0;
  let contractsExpired = 0;
  let guaranteesExpired = 0;
  let occurrencesGenerated = 0;
  let contractsRefreshed = 0;
  let failedOrganizations = 0;
  for (const organizationId of organizations) {
    try {
      const result = await deps.tenant.run({ organizationId, memberId: null, userId: null }, () => monitor.run(now));
      reminders += result.reminders;
      contractsExpired += result.contractsExpired;
      guaranteesExpired += result.guaranteesExpired;
      occurrencesGenerated += result.occurrencesGenerated;
      contractsRefreshed += result.contractsRefreshed;
      if (
        result.contractsExpired + result.guaranteesExpired + result.occurrencesGenerated + result.contractsRefreshed >
        0
      ) {
        await deps.invalidate?.(organizationId, ['commercial']);
      }
    } catch (error) {
      failedOrganizations += 1;
      deps.onOrganizationError(organizationId, error);
    }
  }
  return {
    organizations: organizations.length,
    reminders,
    contractsExpired,
    guaranteesExpired,
    occurrencesGenerated,
    contractsRefreshed,
    failedOrganizations,
  };
}
