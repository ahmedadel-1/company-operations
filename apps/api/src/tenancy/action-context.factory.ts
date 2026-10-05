import { Inject, Injectable } from '@nestjs/common';

import { deserializePermissions, ScopeReachResolver } from '@company-ops/core';
import type { ActionContext, EffectivePermissions } from '@company-ops/core';
import { isPrivilegedPermission } from '@company-ops/shared';

import { AuthService } from '../auth/auth.service.js';
import { auditContext } from '../http/audit-context.js';
import { unauthenticated } from '../http/errors/http-errors.js';
import type { HttpRequest } from '../http/http-types.js';

/**
 * Builds the acting principal for a request from server state only: the session's tenant context
 * and permissions (revalidated against `authz_version` by `SessionGuard`) plus the member's
 * TEAM/DEPARTMENT reach resolved from the organization hierarchy at request time.
 *
 * Without a fresh MFA authentication the principal carries no privileged permission at all, so a
 * service-level check can never be satisfied by a grant the route guard would have refused.
 */
@Injectable()
export class ActionContextFactory {
  constructor(
    @Inject(ScopeReachResolver) private readonly reach: ScopeReachResolver,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async create(request: HttpRequest): Promise<ActionContext> {
    const state = request.auth;
    if (state === undefined) {
      throw unauthenticated();
    }
    const all = deserializePermissions(state.session.permissions);
    const permissions: EffectivePermissions = this.auth.mfaSatisfied(state.session)
      ? all
      : new Map([...all].filter(([key]) => !isPrivilegedPermission(key)));
    const principal = await this.reach.principal({ ...state.tenant, permissions });
    return { principal, request: auditContext(request) };
  }
}
