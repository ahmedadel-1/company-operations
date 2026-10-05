import { JiraApiError } from './jira-errors.js';
import type { JiraHttp } from './jira-http.js';
import { accessibleResourcesSchema, tokenResponseSchema } from './jira-wire.js';
import type { AccessibleResource, TokenResponse } from './jira-wire.js';

/** Deployment-level Jira OAuth 2.0 (3LO) app settings; absent when the integration is disabled. */
export interface JiraAppSettings {
  readonly clientId: string;
  readonly clientSecret: string;
  /** `https://auth.atlassian.com` (overridable only outside production, for the test double). */
  readonly authBaseUrl: string;
  /** `https://api.atlassian.com`. */
  readonly apiBaseUrl: string;
  /** Browser-facing origin; the OAuth redirect and webhook URLs are derived from it. */
  readonly publicUrl: string;
}

/**
 * Scopes requested at consent: read issues/projects, create issues, manage dynamic webhooks, and
 * `offline_access` for a refresh token. Nothing broader.
 */
export const JIRA_SCOPES = ['read:jira-work', 'write:jira-work', 'manage:jira-webhook', 'offline_access'] as const;

/** Scopes a site must grant for the connection to work. */
export const REQUIRED_SITE_SCOPES = ['read:jira-work', 'write:jira-work', 'manage:jira-webhook'] as const;

export function jiraRedirectUri(settings: JiraAppSettings): string {
  return `${settings.publicUrl}/api/v1/integrations/jira/callback`;
}

export function jiraWebhookUrl(settings: JiraAppSettings, connectionId: string): string {
  return `${settings.publicUrl}/api/v1/webhooks/jira/${connectionId}`;
}

/**
 * Atlassian authorization server calls (developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps,
 * checked 2026-10-03). Refresh tokens rotate: every refresh returns a new refresh token that must
 * replace the old one atomically (see `JiraTokenService`).
 */
export class JiraOAuthClient {
  constructor(
    private readonly settings: JiraAppSettings,
    private readonly http: JiraHttp,
  ) {}

  authorizeUrl(state: string): string {
    const url = new URL('/authorize', this.settings.authBaseUrl);
    url.searchParams.set('audience', 'api.atlassian.com');
    url.searchParams.set('client_id', this.settings.clientId);
    url.searchParams.set('scope', JIRA_SCOPES.join(' '));
    url.searchParams.set('redirect_uri', jiraRedirectUri(this.settings));
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('prompt', 'consent');
    return url.toString();
  }

  /** One-time code exchange; never retried (the code is single-use). */
  async exchangeCode(code: string): Promise<TokenResponse> {
    try {
      return await this.http.request({
        method: 'POST',
        url: new URL('/oauth/token', this.settings.authBaseUrl).toString(),
        body: {
          grant_type: 'authorization_code',
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          code,
          redirect_uri: jiraRedirectUri(this.settings),
        },
        schema: tokenResponseSchema,
        idempotent: false,
      });
    } catch (error) {
      throw rejectedGrant(error, 'invalid_request');
    }
  }

  /**
   * Refresh. Atlassian accepts a just-rotated refresh token for a short reuse window, so a retry
   * after a lost response is safe. Any 4xx means the grant is gone (`invalid_grant`, revoked consent).
   */
  async refresh(refreshToken: string): Promise<TokenResponse> {
    try {
      return await this.http.request({
        method: 'POST',
        url: new URL('/oauth/token', this.settings.authBaseUrl).toString(),
        body: {
          grant_type: 'refresh_token',
          client_id: this.settings.clientId,
          client_secret: this.settings.clientSecret,
          refresh_token: refreshToken,
        },
        schema: tokenResponseSchema,
        idempotent: true,
      });
    } catch (error) {
      throw rejectedGrant(error, 'reauth_required');
    }
  }

  async accessibleResources(accessToken: string): Promise<AccessibleResource[]> {
    return this.http.request({
      method: 'GET',
      url: new URL('/oauth/token/accessible-resources', this.settings.apiBaseUrl).toString(),
      headers: { authorization: `Bearer ${accessToken}` },
      schema: accessibleResourcesSchema,
      idempotent: true,
    });
  }
}

function rejectedGrant(error: unknown, kind: 'invalid_request' | 'reauth_required'): unknown {
  if (
    error instanceof JiraApiError &&
    (error.kind === 'unauthorized' ||
      error.kind === 'forbidden' ||
      error.kind === 'invalid_request' ||
      error.kind === 'not_found')
  ) {
    return new JiraApiError(kind, error.status, 'Atlassian rejected the authorization grant.');
  }
  return error;
}
