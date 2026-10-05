import type { ClsService } from 'nestjs-cls';

import type { TenantContext, TenantContextAccessor } from '@company-ops/core';

const TENANT_KEY = 'ops.tenant';

/**
 * Request-scoped tenant context (ADR-0003 invariant 1). Written only by `SessionGuard` from the
 * validated server-side session; nothing reads organization ids from client input.
 */
export class ClsTenantContext implements TenantContextAccessor {
  constructor(private readonly cls: ClsService) {}

  get(): TenantContext | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }
    const value: unknown = this.cls.get(TENANT_KEY);
    return isTenantContext(value) ? value : undefined;
  }

  set(context: TenantContext): void {
    this.cls.set(TENANT_KEY, Object.freeze({ ...context }));
  }
}

function isTenantContext(value: unknown): value is TenantContext {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return typeof v.organizationId === 'string' && typeof v.memberId === 'string' && typeof v.userId === 'string';
}
