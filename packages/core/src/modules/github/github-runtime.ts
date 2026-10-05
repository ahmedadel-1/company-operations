import type { EnvelopeCipher } from '../../platform/crypto/envelope-cipher.js';
import type { KeyValueStore } from '../jira/jira-coordination.js';
import {
  GithubAppAuth,
  GithubAppClient,
  GithubClientFactory,
  GithubTokenService,
  GithubUserAuthClient,
} from './github-client.js';
import type { GithubAppSettings } from './github-client.js';
import { GithubCoordination } from './github-coordination.js';
import { GithubHttp } from './github-http.js';
import type { GithubFetch, GithubHttpOptions } from './github-http.js';

const GITHUB_API = 'https://api.github.com';

/** The GitHub adapter pieces for one process (API or worker). */
export interface GithubRuntime {
  readonly settings: GithubAppSettings;
  readonly http: GithubHttp;
  readonly kv: KeyValueStore;
  readonly coordination: GithubCoordination;
  readonly tokens: GithubTokenService;
  readonly app: GithubAppClient;
  readonly users: GithubUserAuthClient;
  readonly clients: GithubClientFactory;
}

export function createGithubRuntime(input: {
  readonly settings: GithubAppSettings;
  readonly fetch: GithubFetch;
  readonly kv: KeyValueStore;
  readonly cipher: EnvelopeCipher;
  readonly http?: Omit<GithubHttpOptions, 'fetch'>;
  readonly now?: () => number;
}): GithubRuntime {
  const now = input.now ?? Date.now;
  const http = new GithubHttp({ ...input.http, fetch: input.fetch });
  const coordination = new GithubCoordination(input.kv, now);
  const auth = new GithubAppAuth(input.settings, now);
  const tokens = new GithubTokenService(input.settings, http, auth, coordination, input.cipher, now);
  return {
    settings: input.settings,
    http,
    kv: input.kv,
    coordination,
    tokens,
    app: new GithubAppClient(input.settings, http, auth),
    users: new GithubUserAuthClient(input.settings, http),
    clients: new GithubClientFactory(input.settings, http, tokens, coordination),
  };
}

/** True when the API base URL points at the deterministic test double (forbidden in production). */
export function usesGithubTestDouble(settings: Pick<GithubAppSettings, 'apiBaseUrl'>): boolean {
  return settings.apiBaseUrl !== GITHUB_API;
}

/** Callback registered on the App for the setup-time user authorization. */
export function githubCallbackUrl(settings: Pick<GithubAppSettings, 'publicUrl'>): string {
  return `${settings.publicUrl}/api/v1/integrations/github/callback`;
}

export function githubSetupUrl(settings: Pick<GithubAppSettings, 'publicUrl'>): string {
  return `${settings.publicUrl}/api/v1/integrations/github/setup`;
}

export function githubWebhookUrl(settings: Pick<GithubAppSettings, 'publicUrl'>): string {
  return `${settings.publicUrl}/api/v1/webhooks/github`;
}
