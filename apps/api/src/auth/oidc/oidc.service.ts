import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';
import * as client from 'openid-client';

import { newOpaqueToken } from '../session/session.store.js';
import { insecureDevTransport } from './insecure-dev-transport.js';

export interface OidcSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly allowInsecureHttp: boolean;
  /** Browser-facing base URL; the callback is `${publicUrl}/api/v1/auth/callback`. */
  readonly publicUrl: string;
}

export type AuthPurpose = 'login' | 'step-up';

/** Pending authorization request. Stored in Redis under the hash of an opaque cookie handle. */
export interface OidcTransaction {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly returnTo: string;
  readonly purpose: AuthPurpose;
  readonly requestedAcr: string | null;
  /** Organization to keep active after step-up or re-login, if still a valid membership. */
  readonly preferredOrganizationId: string | null;
  /** Invitation to redeem for the authenticated identity (ADR-0012); single use, 10-minute TTL here. */
  readonly invitationToken: string | null;
}

export interface ValidatedLogin {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string | null;
  readonly displayName: string;
  readonly acr: string | null;
  /** Epoch ms. */
  readonly authTime: number | null;
  readonly idpSessionId: string | null;
  readonly idToken: string;
}

export interface LogoutTokenClaims {
  readonly subject: string | null;
  readonly idpSessionId: string | null;
}

export class OidcError extends Error {
  constructor(
    readonly reason: 'transaction_missing' | 'callback_rejected' | 'token_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'OidcError';
  }
}

export const OIDC_TRANSACTION_TTL_MS = 10 * 60_000;
const TX_PREFIX = 'ops:oidc-tx:';
const LOGOUT_JTI_PREFIX = 'ops:oidc-logout-jti:';
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const txKey = (handle: string): string => `${TX_PREFIX}${createHash('sha256').update(handle).digest('hex')}`;

function isTransaction(value: unknown): value is OidcTransaction {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.state === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.codeVerifier === 'string' &&
    typeof v.returnTo === 'string' &&
    (v.purpose === 'login' || v.purpose === 'step-up') &&
    (v.requestedAcr === null || typeof v.requestedAcr === 'string') &&
    (v.preferredOrganizationId === null || typeof v.preferredOrganizationId === 'string') &&
    (v.invitationToken === null || typeof v.invitationToken === 'string')
  );
}

/**
 * OIDC relying party for the API (ADR-0002, SECURITY §3.1): Authorization Code + PKCE (S256) with
 * state and nonce, confidential client authentication, server-side callback and ID token
 * validation by openid-client. Tokens never reach the browser.
 */
export class OidcService {
  private configuration: Promise<client.Configuration> | undefined;
  private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(
    private readonly settings: OidcSettings,
    private readonly redis: Redis,
  ) {}

  get callbackUrl(): string {
    return `${this.settings.publicUrl}/api/v1/auth/callback`;
  }

  /** Lazy discovery so startup never depends on Keycloak; a failed discovery is retried next time. */
  private config(): Promise<client.Configuration> {
    if (this.configuration === undefined) {
      const execute = this.settings.allowInsecureHttp ? [...insecureDevTransport] : [];
      this.configuration = client
        .discovery(
          new URL(this.settings.issuer),
          this.settings.clientId,
          undefined,
          client.ClientSecretBasic(this.settings.clientSecret),
          {
            execute,
          },
        )
        .catch((error: unknown) => {
          this.configuration = undefined;
          throw error;
        });
    }
    return this.configuration;
  }

  /** Creates and stores a transaction; returns the authorization URL and the cookie handle. */
  async beginAuthorization(input: {
    returnTo: string;
    purpose: AuthPurpose;
    requestedAcr: string | null;
    preferredOrganizationId: string | null;
    invitationToken: string | null;
  }): Promise<{ url: string; handle: string }> {
    const config = await this.config();
    const transaction: OidcTransaction = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      codeVerifier: client.randomPKCECodeVerifier(),
      ...input,
    };
    const parameters: Record<string, string> = {
      redirect_uri: this.callbackUrl,
      response_type: 'code',
      scope: 'openid profile email',
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(transaction.codeVerifier),
      code_challenge_method: 'S256',
    };
    if (input.requestedAcr !== null) {
      parameters.acr_values = input.requestedAcr;
    }
    const handle = newOpaqueToken();
    await this.redis.set(txKey(handle), JSON.stringify(transaction), 'PX', OIDC_TRANSACTION_TTL_MS);
    return { url: client.buildAuthorizationUrl(config, parameters).href, handle };
  }

  /** Single use: the transaction is deleted when read. */
  async takeTransaction(handle: string | undefined): Promise<OidcTransaction> {
    if (handle === undefined) {
      throw new OidcError('transaction_missing', 'No pending authorization request.');
    }
    const raw = await this.redis.getdel(txKey(handle));
    let parsed: unknown = null;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    }
    if (!isTransaction(parsed)) {
      throw new OidcError('transaction_missing', 'The authorization request expired or was already used.');
    }
    return parsed;
  }

  /**
   * Exchanges the code (PKCE verifier + client secret) and validates the ID token: signature,
   * issuer, audience, expiry, nonce and state are checked by openid-client.
   */
  async completeAuthorization(callbackQuery: string, transaction: OidcTransaction): Promise<ValidatedLogin> {
    const config = await this.config();
    const currentUrl = new URL(`${this.callbackUrl}${callbackQuery}`);
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      throw new OidcError('callback_rejected', error instanceof Error ? error.message : 'Authorization failed.');
    }
    const claims = tokens.claims();
    const idToken = tokens.id_token;
    if (claims === undefined || idToken === undefined) {
      throw new OidcError('token_invalid', 'The provider did not return an ID token.');
    }
    const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
    const displayName =
      text(claims.name) ?? text(claims.preferred_username) ?? text(claims.email) ?? `user-${claims.sub.slice(0, 8)}`;
    return {
      issuer: claims.iss,
      subject: claims.sub,
      email: claims.email_verified === true ? text(claims.email) : null,
      displayName,
      acr: text(claims.acr),
      authTime: typeof claims.auth_time === 'number' ? claims.auth_time * 1000 : null,
      idpSessionId: text(claims.sid),
      idToken,
    };
  }

  async buildLogoutUrl(idTokenHint: string | null): Promise<string> {
    const config = await this.config();
    const parameters: Record<string, string> = {
      client_id: this.settings.clientId,
      post_logout_redirect_uri: `${this.settings.publicUrl}/`,
    };
    if (idTokenHint !== null) {
      parameters.id_token_hint = idTokenHint;
    }
    return client.buildEndSessionUrl(config, parameters).href;
  }

  /**
   * Validates a back-channel logout token (OIDC Back-Channel Logout 1.0 §2.6): signature from the
   * provider JWKS, issuer, audience, freshness, the logout event, no nonce, and single use (jti).
   */
  async verifyLogoutToken(token: string): Promise<LogoutTokenClaims> {
    const config = await this.config();
    const metadata = config.serverMetadata();
    if (metadata.jwks_uri === undefined) {
      throw new OidcError('token_invalid', 'Provider metadata has no jwks_uri.');
    }
    this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri));
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks, {
        issuer: metadata.issuer,
        audience: this.settings.clientId,
        maxTokenAge: '5m',
        requiredClaims: ['iat', 'jti', 'events'],
      }));
    } catch (error) {
      throw new OidcError('token_invalid', error instanceof Error ? error.message : 'Invalid logout token.');
    }
    const events = payload.events;
    const hasEvent = typeof events === 'object' && events !== null && BACKCHANNEL_EVENT in events;
    const subject = typeof payload.sub === 'string' ? payload.sub : null;
    const sid = typeof payload.sid === 'string' ? payload.sid : null;
    if (!hasEvent || 'nonce' in payload || (subject === null && sid === null) || typeof payload.jti !== 'string') {
      throw new OidcError('token_invalid', 'Logout token claims are invalid.');
    }
    const fresh = await this.redis.set(`${LOGOUT_JTI_PREFIX}${payload.jti}`, '1', 'PX', 10 * 60_000, 'NX');
    if (fresh === null) {
      throw new OidcError('token_invalid', 'Logout token was already used.');
    }
    return { subject, idpSessionId: sid };
  }
}
