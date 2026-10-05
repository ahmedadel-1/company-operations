import type { EnvelopeCipher } from '../../platform/crypto/envelope-cipher.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { JiraClientFactory } from './jira-client.js';
import { JiraCoordination } from './jira-coordination.js';
import type { KeyValueStore } from './jira-coordination.js';
import { JiraHttp } from './jira-http.js';
import type { FetchLike, JiraHttpOptions } from './jira-http.js';
import { JiraOAuthClient } from './jira-oauth.js';
import type { JiraAppSettings } from './jira-oauth.js';
import { JiraTokenService } from './jira-tokens.js';

const ATLASSIAN_API = 'https://api.atlassian.com';

/** The adapter pieces for one process (API or worker). */
export interface JiraRuntime {
  readonly settings: JiraAppSettings;
  readonly oauth: JiraOAuthClient;
  readonly coordination: JiraCoordination;
  readonly kv: KeyValueStore;
  readonly tokens: JiraTokenService;
  readonly clients: JiraClientFactory;
}

export function createJiraRuntime(input: {
  readonly settings: JiraAppSettings;
  readonly fetch: FetchLike;
  readonly kv: KeyValueStore;
  readonly db: TenantDb;
  readonly cipher: EnvelopeCipher;
  readonly http?: Omit<JiraHttpOptions, 'fetch'>;
}): JiraRuntime {
  const http = new JiraHttp({ ...input.http, fetch: input.fetch });
  const oauth = new JiraOAuthClient(input.settings, http);
  const coordination = new JiraCoordination(input.kv);
  const tokens = new JiraTokenService(input.db, input.cipher, oauth, coordination);
  const clients = new JiraClientFactory(input.settings, http, tokens, coordination, input.db);
  return { settings: input.settings, oauth, coordination, kv: input.kv, tokens, clients };
}

/**
 * True when the API base URL points at the deterministic test double. Configuration forbids this in
 * production, so it is safe to relax https-only rules for sites and webhook callbacks on it.
 */
export function usesTestDouble(settings: Pick<JiraAppSettings, 'apiBaseUrl'>): boolean {
  return settings.apiBaseUrl !== ATLASSIAN_API;
}

/** Jira only delivers webhooks to https URLs; without one, reconciliation alone keeps the cache fresh. */
export function canRegisterWebhooks(settings: Pick<JiraAppSettings, 'apiBaseUrl' | 'publicUrl'>): boolean {
  return settings.publicUrl.startsWith('https://') || usesTestDouble(settings);
}
