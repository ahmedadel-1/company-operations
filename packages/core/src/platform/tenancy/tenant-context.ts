import { AsyncLocalStorage } from 'node:async_hooks';

import { TenantIsolationError } from '../errors.js';

/**
 * Server-derived tenant context (ADR-0003 invariant 1): built from the authenticated session (API)
 * or a validated job payload (worker). Never from client input.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly memberId: string;
  readonly userId: string;
}

/**
 * Tenant context of a background job acting for the system inside one organization (outbox
 * consumers, maintenance). It binds the tenant guard exactly like a member context but carries no
 * acting member, so member-scoped services refuse to run under it.
 */
export interface SystemTenantContext {
  readonly organizationId: string;
  readonly memberId: null;
  readonly userId: null;
}

export type AnyTenantContext = TenantContext | SystemTenantContext;

/** Read access to the current request/job tenant context. Each runtime adapter provides one. */
export interface TenantContextAccessor {
  get(): AnyTenantContext | undefined;
}

/** The acting member's context; throws outside a tenant context or under a system context. */
export function requireTenantContext(accessor: TenantContextAccessor): TenantContext {
  const context = accessor.get();
  if (context === undefined) {
    throw new TenantIsolationError('No tenant context is active for this operation.');
  }
  if (context.memberId === null) {
    throw new TenantIsolationError('This operation requires a member context, not a system context.');
  }
  return context;
}

export function requireAnyTenantContext(accessor: TenantContextAccessor): AnyTenantContext {
  const context = accessor.get();
  if (context === undefined) {
    throw new TenantIsolationError('No tenant context is active for this operation.');
  }
  return context;
}

/** AsyncLocalStorage-backed accessor for non-HTTP code paths (worker jobs, scripts, tests). */
export class AsyncLocalTenantContext implements TenantContextAccessor {
  private readonly storage = new AsyncLocalStorage<AnyTenantContext>();

  get(): AnyTenantContext | undefined {
    return this.storage.getStore();
  }

  run<T>(context: AnyTenantContext, fn: () => T): T {
    return this.storage.run(Object.freeze({ ...context }), fn);
  }
}
