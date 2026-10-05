import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';

import { MFA_ACR } from '@company-ops/core';
import { ERROR_CODES } from '@company-ops/shared';
import {
  backchannelLogoutRequestSchema,
  csrfTokenResponseSchema,
  loginQuerySchema,
  logoutResponseSchema,
  signInQuerySchema,
} from '@company-ops/validation';
import type { BackchannelLogoutRequest, LoginQuery, SignInQuery } from '@company-ops/validation';

import { API_ENV } from '../config/api-env.js';
import type { ApiEnv } from '../config/api-env.js';
import { auditContext } from '../http/audit-context.js';
import type { AuthenticatedRequestState, HttpRequest, HttpResponse } from '../http/http-types.js';
import { ApiEmptyOk, ApiRedirect, ApiResult } from '../http/openapi.js';
import { AuthService } from './auth.service.js';
import { AuthRateLimit, CurrentAuth, Public, SkipCsrf, WebhookRateLimit } from './decorators.js';
import { OidcError, OidcService, OIDC_TRANSACTION_TTL_MS } from './oidc/oidc.service.js';
import type { AuthPurpose } from './oidc/oidc.service.js';
import {
  clearOidcTransactionCookie,
  clearSessionCookie,
  OIDC_TX_COOKIE,
  readCookie,
  SESSION_COOKIE,
  setOidcTransactionCookie,
  setSessionCookie,
} from './session/cookies.js';
import { SessionStore } from './session/session.store.js';

/** Query string of the callback as received (code, state, iss, session_state or error). */
function callbackQuery(request: HttpRequest): string {
  const index = request.originalUrl.indexOf('?');
  return index < 0 ? '' : request.originalUrl.slice(index);
}

/**
 * OIDC login/logout for the BFF (ARCHITECTURE §6, SECURITY §3). Browser-facing redirects; the
 * authorization code is exchanged server-side and no token is ever returned to the browser.
 */
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionStore) private readonly sessions: SessionStore,
  ) {}

  @Get('login')
  @Public()
  @AuthRateLimit()
  @ApiRedirect('Redirect to the identity provider (Authorization Code + PKCE)')
  async login(@Query({ schema: signInQuerySchema }) query: SignInQuery, @Res() response: HttpResponse): Promise<void> {
    await this.redirectToProvider(response, {
      returnTo: query.returnTo ?? '/',
      purpose: 'login',
      requestedAcr: null,
      preferredOrganizationId: null,
      invitationToken: query.invitation ?? null,
    });
  }

  /** Re-authenticates with `acr_values=mfa` (SECURITY §3.2); the result is a new, rotated session. */
  @Get('step-up')
  @AuthRateLimit()
  @ApiRedirect('Redirect to the identity provider with acr_values=mfa')
  async stepUp(
    @Query({ schema: loginQuerySchema }) query: LoginQuery,
    @CurrentAuth() auth: AuthenticatedRequestState,
    @Res() response: HttpResponse,
  ): Promise<void> {
    await this.redirectToProvider(response, {
      returnTo: query.returnTo ?? '/',
      purpose: 'step-up',
      requestedAcr: MFA_ACR,
      preferredOrganizationId: auth.session.organizationId,
      invitationToken: null,
    });
  }

  @Get('callback')
  @Public()
  @AuthRateLimit()
  @ApiRedirect('Redirect to the web app (session cookie set) or to /?authError=<reason>')
  async callback(@Req() request: HttpRequest, @Res() response: HttpResponse): Promise<void> {
    clearOidcTransactionCookie(response);
    try {
      const transaction = await this.oidc.takeTransaction(readCookie(request, OIDC_TX_COOKIE));
      const login = await this.oidc.completeAuthorization(callbackQuery(request), transaction);
      const outcome = await this.auth.completeLogin(login, transaction, auditContext(request));
      if (outcome.kind === 'rejected') {
        this.failRedirect(response, outcome.reason);
        return;
      }
      if (outcome.kind === 'mfa-required') {
        // Any invitation was already redeemed; the MFA round trip does not carry it again.
        await this.redirectToProvider(response, {
          returnTo: outcome.returnTo,
          purpose: transaction.purpose,
          requestedAcr: MFA_ACR,
          preferredOrganizationId: outcome.preferredOrganizationId,
          invitationToken: null,
        });
        return;
      }
      // Fixation: any pre-existing session is discarded; the new id was generated server-side.
      const previous = readCookie(request, SESSION_COOKIE);
      if (previous !== undefined) {
        await this.sessions.destroy(previous, await this.sessions.load(previous));
      }
      setSessionCookie(response, outcome.sessionId, this.sessions.cookieMaxAgeMs(outcome.record));
      response.redirect(302, `${this.env.APP_PUBLIC_URL}${outcome.returnTo}`);
    } catch (error) {
      if (error instanceof OidcError) {
        this.logger.warn({ reason: error.reason }, 'OIDC callback rejected');
        this.failRedirect(response, error.reason);
        return;
      }
      throw error;
    }
  }

  @Get('csrf')
  @Header('Cache-Control', 'no-store')
  @ApiResult(csrfTokenResponseSchema)
  csrf(@CurrentAuth() auth: AuthenticatedRequestState): { data: { csrfToken: string } } {
    return { data: { csrfToken: auth.session.csrfToken } };
  }

  /** Ends the local session and returns the Keycloak end-session URL for the browser to visit. */
  @Post('logout')
  @Header('Cache-Control', 'no-store')
  @ApiResult(logoutResponseSchema)
  async logout(
    @CurrentAuth() auth: AuthenticatedRequestState,
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ data: { logoutUrl: string } }> {
    const logoutUrl = await this.auth.logout(auth.sessionId, auth.session, auditContext(request));
    clearSessionCookie(response);
    return { data: { logoutUrl } };
  }

  /** OIDC Back-Channel Logout 1.0: authenticated by the signed logout token, not by cookies. */
  @Post('backchannel-logout')
  @Public()
  @SkipCsrf()
  @WebhookRateLimit()
  @Header('Cache-Control', 'no-store')
  @ApiEmptyOk()
  async backchannelLogout(
    @Body({ schema: backchannelLogoutRequestSchema }) body: BackchannelLogoutRequest,
    @Req() request: HttpRequest,
  ): Promise<void> {
    const claims = await this.oidc.verifyLogoutToken(body.logout_token).catch((error: unknown) => {
      if (error instanceof OidcError) {
        this.logger.warn({ reason: error.reason }, 'Back-channel logout token rejected');
        throw new BadRequestException({ code: ERROR_CODES.VALIDATION_FAILED, message: 'Invalid logout token.' });
      }
      throw error;
    });
    if (claims.idpSessionId === null) {
      // The client requires `sid` (backchannel.logout.session.required); subject-only tokens are not supported.
      this.logger.warn('Back-channel logout token without sid ignored');
      return;
    }
    const removed = await this.auth.backchannelLogout(claims.idpSessionId, auditContext(request));
    this.logger.log({ removed }, 'Back-channel logout processed');
  }

  private async redirectToProvider(
    response: HttpResponse,
    request: {
      returnTo: string;
      purpose: AuthPurpose;
      requestedAcr: string | null;
      preferredOrganizationId: string | null;
      invitationToken: string | null;
    },
  ): Promise<void> {
    const { url, handle } = await this.oidc.beginAuthorization(request);
    setOidcTransactionCookie(response, handle, OIDC_TRANSACTION_TTL_MS);
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, url);
  }

  private failRedirect(response: HttpResponse, reason: string): void {
    response.setHeader('Cache-Control', 'no-store');
    response.redirect(302, `${this.env.APP_PUBLIC_URL}/?authError=${encodeURIComponent(reason)}`);
  }
}
