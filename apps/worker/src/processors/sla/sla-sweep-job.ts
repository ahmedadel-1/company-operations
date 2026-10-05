import { organizationsWithOpenTickets, SlaSweep } from '@company-ops/core';
import type { AsyncLocalTenantContext, PrismaClient, TenantScopedClient } from '@company-ops/core';

export const SLA_SWEEP_JOB = 'sla.sweep';

export interface SlaSweepTotals {
  readonly organizations: number;
  readonly tickets: number;
  readonly updated: number;
  readonly conditions: number;
  readonly escalations: number;
  readonly failedOrganizations: number;
}

/**
 * Evaluates SLAs for every organization with open tickets. The organization scan is cross-tenant
 * (system maintenance); each organization runs in a system tenant context of its own, so one
 * organization's data never mixes with another's. A failing organization does not stop the others;
 * the job fails afterwards (kept visible in BullMQ) and the next scheduled run retries. Re-running
 * is harmless: conditions and escalations are recorded once per ticket, kind and level.
 */
export async function sweepSlas(
  deps: {
    readonly prisma: PrismaClient;
    readonly db: TenantScopedClient;
    readonly tenant: AsyncLocalTenantContext;
    readonly onOrganizationError: (organizationId: string, error: unknown) => void;
  },
  now: Date,
): Promise<SlaSweepTotals> {
  const organizations = await organizationsWithOpenTickets(deps.prisma);
  const sweep = new SlaSweep(deps.db, deps.tenant);
  let tickets = 0;
  let updated = 0;
  let conditions = 0;
  let escalations = 0;
  let failedOrganizations = 0;
  for (const organizationId of organizations) {
    try {
      const result = await deps.tenant.run({ organizationId, memberId: null, userId: null }, () => sweep.run(now));
      tickets += result.tickets;
      updated += result.updated;
      conditions += result.conditions;
      escalations += result.escalations;
    } catch (error) {
      failedOrganizations += 1;
      deps.onOrganizationError(organizationId, error);
    }
  }
  return { organizations: organizations.length, tickets, updated, conditions, escalations, failedOrganizations };
}
