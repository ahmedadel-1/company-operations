import type { AuditActor, AuditRequestContext } from '../platform/audit/audit-writer.js';
import { TenantIsolationError } from '../platform/errors.js';
import { requireTenantContext } from '../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../platform/tenancy/tenant-context.js';
import type { Principal } from './authorization/policy.js';

/** Who is acting (server-derived principal) and the request facts recorded in audit rows. */
export interface ActionContext {
  readonly principal: Principal;
  readonly request?: AuditRequestContext | undefined;
}

/**
 * The principal must belong to the active tenant context. Both come from the same session, so a
 * mismatch is a programming error and fails closed.
 */
export function boundOrganizationId(tenant: TenantContextAccessor, action: ActionContext): string {
  const context = requireTenantContext(tenant);
  if (context.organizationId !== action.principal.organizationId || context.memberId !== action.principal.memberId) {
    throw new TenantIsolationError('The acting principal does not match the active tenant context.');
  }
  return context.organizationId;
}

export function userActor(action: ActionContext): AuditActor {
  return { type: 'USER', userId: action.principal.userId, memberId: action.principal.memberId };
}
