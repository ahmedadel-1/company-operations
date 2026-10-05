import { ForbiddenError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { canAccessResource } from '../authorization/policy.js';

export interface FailingOutboxEventView {
  readonly id: string;
  readonly eventType: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  /** When the relay will try again (or the time of the last attempt once attempts are exhausted). */
  readonly nextAttemptAt: string;
}

export const MAX_FAILED_LIST = 100;

/**
 * Outbox events of the active organization that the relay could not hand to the queue (P1-15
 * failed-job visibility). Includes events still being retried and events out of attempts.
 * Payloads are never returned. Requires `org.settings.manage`.
 */
export class FailedOutboxService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext): Promise<FailingOutboxEventView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!canAccessResource(action.principal, 'org.settings.manage', { organizationId })) {
      throw new ForbiddenError();
    }
    const rows = await this.db.outboxEvent.findMany({
      where: { organizationId, dispatchedAt: null, lastError: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_FAILED_LIST,
      select: { id: true, eventType: true, attempts: true, lastError: true, createdAt: true, availableAt: true },
    });
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      nextAttemptAt: row.availableAt.toISOString(),
    }));
  }
}
