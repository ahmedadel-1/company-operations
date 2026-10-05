import { Body, Controller, Get, Header, Inject, Put, Req, Res } from '@nestjs/common';

import { deserializePermissions, IdentityService, scopesFor } from '@company-ops/core';
import {
  meResponseSchema,
  switchOrganizationRequestSchema,
  switchOrganizationResponseSchema,
} from '@company-ops/validation';
import type { MeResponse, SwitchOrganizationRequest } from '@company-ops/validation';

import { mfaRequired, sessionExpired } from '../http/errors/http-errors.js';
import { auditContext } from '../http/audit-context.js';
import type { AuthenticatedRequestState, HttpRequest, HttpResponse } from '../http/http-types.js';
import { ApiResult } from '../http/openapi.js';
import { AuthService } from './auth.service.js';
import { CurrentAuth } from './decorators.js';
import { setSessionCookie } from './session/cookies.js';
import { SessionStore } from './session/session.store.js';

/** Current user and active organization context (SECURITY §3.3). */
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionStore) private readonly sessions: SessionStore,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiResult(meResponseSchema)
  async me(@CurrentAuth() auth: AuthenticatedRequestState): Promise<MeResponse> {
    const session = auth.session;
    const [user, memberships] = await Promise.all([
      this.identities.getUser(session.userId),
      this.identities.listActiveMemberships(session.userId),
    ]);
    const active = memberships.find((m) => m.organizationId === session.organizationId);
    if (user === null || active === undefined) {
      throw sessionExpired();
    }
    const permissions = deserializePermissions(session.permissions);
    return {
      data: {
        user: { id: user.id, displayName: user.displayName, email: user.email },
        activeOrganization: {
          id: active.organizationId,
          slug: active.slug,
          name: active.name,
          memberId: session.memberId,
        },
        memberships: memberships.map((m) => ({
          organizationId: m.organizationId,
          slug: m.slug,
          name: m.name,
          active: m.organizationId === session.organizationId,
        })),
        permissions: [...permissions.keys()].sort().map((key) => ({ key, scopes: [...scopesFor(permissions, key)] })),
        mfa: { satisfied: this.auth.mfaSatisfied(session), acr: session.acr },
      },
    };
  }

  /** The target must be one of the user's own active memberships; the session id and CSRF token rotate. */
  @Put('active-organization')
  @Header('Cache-Control', 'no-store')
  @ApiResult(switchOrganizationResponseSchema)
  async switchOrganization(
    @Body({ schema: switchOrganizationRequestSchema }) body: SwitchOrganizationRequest,
    @CurrentAuth() auth: AuthenticatedRequestState,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ data: { organizationId: string; csrfToken: string } }> {
    const result = await this.auth.switchOrganization(
      auth.sessionId,
      auth.session,
      body.organizationId,
      auditContext(request),
    );
    if ('mfaRequired' in result) {
      throw mfaRequired();
    }
    setSessionCookie(response, result.sessionId, this.sessions.cookieMaxAgeMs(result.record));
    return { data: { organizationId: result.record.organizationId, csrfToken: result.record.csrfToken } };
  }
}
