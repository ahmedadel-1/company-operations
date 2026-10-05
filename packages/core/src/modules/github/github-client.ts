import type { KeyObject } from 'node:crypto';

import type { z } from 'zod';

import type { EnvelopeCipher } from '../../platform/crypto/envelope-cipher.js';
import { LockBusyError } from '../jira/jira-coordination.js';
import { tokenCacheKey, tokenLockKey } from './github-coordination.js';
import type { GithubCoordination } from './github-coordination.js';
import { createAppJwt } from './github-crypto.js';
import { GithubApiError } from './github-errors.js';
import type { GithubHttp, GithubResponse } from './github-http.js';
import {
  accessTokenSchema,
  checkRunListSchema,
  combinedStatusSchema,
  installationRepositoriesSchema,
  installationSchema,
  pullRequestListSchema,
  pullRequestSchema,
  repositorySchema,
  reviewListSchema,
  userInstallationsSchema,
  userTokenSchema,
} from './github-wire.js';
import type {
  CheckRunWire,
  CombinedStatusWire,
  InstallationWire,
  PullRequestWire,
  RepositoryWire,
  ReviewWire,
} from './github-wire.js';

/** Deployment-wide GitHub App settings (from the environment; the private key never leaves memory). */
export interface GithubAppSettings {
  readonly appId: string;
  readonly clientId: string;
  readonly privateKey: KeyObject;
  /** API only (setup flow); null in the worker. */
  readonly clientSecret: string | null;
  readonly slug: string | null;
  readonly webhookSecret: string | null;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
  readonly publicUrl: string;
}

/** Renew installation tokens this long before GitHub's `expires_at`. */
export const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;
/** Re-sign the App JWT this long before it expires. */
const JWT_RENEW_MARGIN_MS = 60 * 1000;
/** Pages read by one bounded listing (100 items each). */
const MAX_DETAIL_PAGES = 10;

/** Signs App JWTs (cached in memory until shortly before expiry). Never logged or returned. */
export class GithubAppAuth {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly settings: Pick<GithubAppSettings, 'clientId' | 'privateKey'>,
    private readonly now: () => number = Date.now,
  ) {}

  jwt(): string {
    const now = this.now();
    if (this.cached === null || this.cached.expiresAt - JWT_RENEW_MARGIN_MS <= now) {
      this.cached = createAppJwt(this.settings.clientId, this.settings.privateKey, Math.floor(now / 1000));
    }
    return this.cached.token;
  }
}

const tokenAad = (githubInstallationId: string): string => `github-installation-token|${githubInstallationId}`;

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

function parseCached(raw: string): CachedToken | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'token' in value &&
      'expiresAt' in value &&
      typeof value.token === 'string' &&
      typeof value.expiresAt === 'number'
    ) {
      return { token: value.token, expiresAt: value.expiresAt };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Installation access tokens (docs "Generating an installation access token", checked 2026-10-03):
 * created server-side with the App JWT, valid for one hour, never persisted in the database, never
 * returned to callers outside the adapter and never logged. Each token is cached in memory and,
 * encrypted with the deployment key, in Redis until `TOKEN_RENEW_MARGIN_MS` before the `expires_at`
 * GitHub returned — no assumption about token length or format (the stateless `ghs_` rollout makes
 * them variable-length). Creation runs under a per-installation lock with a re-check after
 * acquiring it, so concurrent requests share one token instead of minting one each.
 */
export class GithubTokenService {
  private readonly memory = new Map<string, CachedToken>();

  constructor(
    private readonly settings: Pick<GithubAppSettings, 'apiBaseUrl'>,
    private readonly http: GithubHttp,
    private readonly app: GithubAppAuth,
    private readonly coordination: GithubCoordination,
    private readonly cipher: EnvelopeCipher,
    private readonly now: () => number = Date.now,
  ) {}

  /** A valid token; `rejected` is a token GitHub just refused (forces a new one unless already replaced). */
  async installationToken(githubInstallationId: string, rejected: string | null = null): Promise<string> {
    const fresh = await this.cached(githubInstallationId);
    if (fresh !== null && fresh !== rejected) {
      return fresh;
    }
    try {
      return await this.coordination.withLock(
        tokenLockKey(githubInstallationId),
        { ttlMs: 30_000, waitMs: 10_000 },
        async () => {
          const current = await this.cached(githubInstallationId);
          if (current !== null && current !== rejected) {
            return current;
          }
          return this.create(githubInstallationId);
        },
      );
    } catch (error) {
      if (error instanceof LockBusyError) {
        throw new GithubApiError('unavailable', null, 'Installation token creation is in progress elsewhere.');
      }
      throw error;
    }
  }

  /** Drops a cached token (installation deleted or suspended). */
  async invalidate(githubInstallationId: string): Promise<void> {
    this.memory.delete(githubInstallationId);
    await this.coordination.store.take(tokenCacheKey(githubInstallationId));
  }

  private usable(entry: CachedToken | null): entry is CachedToken {
    return entry !== null && entry.expiresAt - TOKEN_RENEW_MARGIN_MS > this.now();
  }

  private async cached(githubInstallationId: string): Promise<string | null> {
    const local = this.memory.get(githubInstallationId) ?? null;
    if (this.usable(local)) {
      return local.token;
    }
    this.memory.delete(githubInstallationId);
    const raw = await this.coordination.store.get(tokenCacheKey(githubInstallationId));
    if (raw === null) {
      return null;
    }
    let entry: CachedToken | null;
    try {
      entry = parseCached(this.cipher.decrypt(raw, tokenAad(githubInstallationId)));
    } catch {
      entry = null;
    }
    if (!this.usable(entry)) {
      return null;
    }
    this.memory.set(githubInstallationId, entry);
    return entry.token;
  }

  private async create(githubInstallationId: string): Promise<string> {
    const response = await this.http.request({
      method: 'POST',
      url: `${this.settings.apiBaseUrl}/app/installations/${encodeURIComponent(githubInstallationId)}/access_tokens`,
      headers: { authorization: `Bearer ${this.app.jwt()}` },
      schema: accessTokenSchema,
      idempotent: true,
    });
    const expiresAt = Date.parse(response.data.expires_at);
    const entry: CachedToken = { token: response.data.token, expiresAt };
    const ttl = expiresAt - TOKEN_RENEW_MARGIN_MS - this.now();
    if (ttl > 0) {
      this.memory.set(githubInstallationId, entry);
      await this.coordination.store.set(
        tokenCacheKey(githubInstallationId),
        this.cipher.encrypt(JSON.stringify(entry), tokenAad(githubInstallationId)),
        ttl,
      );
    }
    return entry.token;
  }
}

/** App-level calls authenticated with the App JWT. */
export class GithubAppClient {
  constructor(
    private readonly settings: Pick<GithubAppSettings, 'apiBaseUrl'>,
    private readonly http: GithubHttp,
    private readonly app: GithubAppAuth,
  ) {}

  async getInstallation(githubInstallationId: string): Promise<InstallationWire> {
    const response = await this.http.request({
      method: 'GET',
      url: `${this.settings.apiBaseUrl}/app/installations/${encodeURIComponent(githubInstallationId)}`,
      headers: { authorization: `Bearer ${this.app.jwt()}` },
      schema: installationSchema,
      idempotent: true,
    });
    return response.data;
  }
}

/**
 * The installing administrator's GitHub identity, used only during setup to prove that the GitHub
 * user can access the installation (docs "About the setup URL": `installation_id` can be spoofed).
 * The user token lives in memory for the duration of one request and is revoked afterwards.
 */
export class GithubUserAuthClient {
  constructor(
    private readonly settings: Pick<GithubAppSettings, 'apiBaseUrl' | 'webBaseUrl' | 'clientId' | 'clientSecret'>,
    private readonly http: GithubHttp,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: redirectUri,
      state,
      allow_signup: 'false',
    });
    return `${this.settings.webBaseUrl}/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const secret = this.requireSecret();
    const response = await this.http.request({
      method: 'POST',
      url: `${this.settings.webBaseUrl}/login/oauth/access_token`,
      body: { client_id: this.settings.clientId, client_secret: secret, code, redirect_uri: redirectUri },
      schema: userTokenSchema,
      idempotent: false,
      plainJson: true,
    });
    if (response.data.access_token === undefined) {
      throw new GithubApiError('invalid_request', 200, 'GitHub did not accept the authorization code.');
    }
    return response.data.access_token;
  }

  /** Installation ids the user can access (`GET /user/installations`, paginated, bounded). */
  async installationIds(userToken: string, maxPages = 10): Promise<Set<string>> {
    const ids = new Set<string>();
    let url: string | null = `${this.settings.apiBaseUrl}/user/installations?per_page=100`;
    for (let page = 0; url !== null && page < maxPages; page += 1) {
      const response: GithubResponse<z.output<typeof userInstallationsSchema>> = await this.http.request({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${userToken}` },
        schema: userInstallationsSchema,
        idempotent: true,
      });
      for (const installation of response.data.installations) {
        ids.add(String(installation.id));
      }
      url = response.next;
    }
    return ids;
  }

  /** Best effort: revokes the user token (`DELETE /applications/{client_id}/token`). */
  async revoke(userToken: string): Promise<void> {
    const secret = this.requireSecret();
    const basic = Buffer.from(`${this.settings.clientId}:${secret}`).toString('base64');
    await this.http.send({
      method: 'DELETE',
      url: `${this.settings.apiBaseUrl}/applications/${encodeURIComponent(this.settings.clientId)}/token`,
      headers: { authorization: `Basic ${basic}` },
      body: { access_token: userToken },
      idempotent: true,
    });
  }

  private requireSecret(): string {
    if (this.settings.clientSecret === null) {
      throw new GithubApiError('unauthorized', null, 'The GitHub App client secret is not configured here.');
    }
    return this.settings.clientSecret;
  }
}

export interface InstallationRef {
  /** `github_installations.id` (pause bookkeeping). */
  readonly installationRowId: string;
  /** GitHub's installation id. */
  readonly githubInstallationId: string;
}

export interface PullListPage {
  readonly pulls: PullRequestWire[];
  readonly hasNext: boolean;
}

const DEFAULT_PAUSE_MS = 60_000;

function repoPath(fullName: string): string {
  const [owner, name, ...rest] = fullName.split('/');
  if (owner === undefined || name === undefined || rest.length > 0 || owner === '' || name === '') {
    throw new GithubApiError('invalid_request', null, 'Invalid repository name.');
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * REST calls for one installation, authenticated with its installation token. The installation-wide
 * pause is honoured before each call and set when GitHub rate limits, so one limited request slows
 * every process using that installation. A 401 renews the token once.
 */
export class GithubInstallationClient {
  constructor(
    private readonly ref: InstallationRef,
    private readonly settings: Pick<GithubAppSettings, 'apiBaseUrl'>,
    private readonly http: GithubHttp,
    private readonly tokens: GithubTokenService,
    private readonly coordination: GithubCoordination,
    private readonly now: () => number = Date.now,
  ) {}

  /** Repositories the installation can access (`GET /installation/repositories`, all pages, bounded). */
  async listRepositories(maxPages = 100): Promise<{ repositories: RepositoryWire[]; complete: boolean }> {
    const repositories: RepositoryWire[] = [];
    let url: string | null = `${this.settings.apiBaseUrl}/installation/repositories?per_page=100`;
    let page = 0;
    for (; url !== null && page < maxPages; page += 1) {
      const response: GithubResponse<z.output<typeof installationRepositoriesSchema>> = await this.call(
        url,
        installationRepositoriesSchema,
      );
      repositories.push(...response.data.repositories);
      url = response.next;
    }
    return { repositories, complete: url === null };
  }

  async getRepository(githubRepoId: string): Promise<RepositoryWire> {
    const response = await this.call(
      `${this.settings.apiBaseUrl}/repositories/${encodeURIComponent(githubRepoId)}`,
      repositorySchema,
    );
    return response.data;
  }

  /** One page of pull requests (100 per page); page numbers make durable checkpoints. */
  async listPulls(
    fullName: string,
    options: { state: 'open' | 'closed' | 'all'; sort: 'created' | 'updated'; page: number },
  ): Promise<PullListPage> {
    const params = new URLSearchParams({
      state: options.state,
      sort: options.sort,
      direction: 'desc',
      per_page: '100',
      page: String(options.page),
    });
    const response = await this.call(
      `${this.settings.apiBaseUrl}${repoPath(fullName)}/pulls?${params.toString()}`,
      pullRequestListSchema,
    );
    return { pulls: response.data, hasNext: response.next !== null };
  }

  async getPull(fullName: string, number: number): Promise<PullRequestWire> {
    const response = await this.call(
      `${this.settings.apiBaseUrl}${repoPath(fullName)}/pulls/${String(number)}`,
      pullRequestSchema,
    );
    return response.data;
  }

  async listReviews(fullName: string, number: number): Promise<ReviewWire[]> {
    return this.collect(
      `${this.settings.apiBaseUrl}${repoPath(fullName)}/pulls/${String(number)}/reviews?per_page=100`,
      reviewListSchema,
      (page) => page,
    );
  }

  async listCheckRuns(fullName: string, sha: string): Promise<CheckRunWire[]> {
    return this.collect(
      `${this.settings.apiBaseUrl}${repoPath(fullName)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100&filter=latest`,
      checkRunListSchema,
      (page) => page.check_runs,
    );
  }

  async combinedStatus(fullName: string, sha: string): Promise<CombinedStatusWire> {
    const response = await this.call(
      `${this.settings.apiBaseUrl}${repoPath(fullName)}/commits/${encodeURIComponent(sha)}/status?per_page=100`,
      combinedStatusSchema,
    );
    return response.data;
  }

  private async collect<P, I>(first: string, schema: z.ZodType<P>, items: (page: P) => I[]): Promise<I[]> {
    const out: I[] = [];
    let url: string | null = first;
    for (let page = 0; url !== null && page < MAX_DETAIL_PAGES; page += 1) {
      const response: GithubResponse<P> = await this.call(url, schema);
      out.push(...items(response.data));
      url = response.next;
    }
    return out;
  }

  private async call<T>(url: string, schema: z.ZodType<T>): Promise<GithubResponse<T>> {
    const paused = await this.coordination.pausedUntil(this.ref.installationRowId);
    if (paused !== null) {
      throw new GithubApiError('rate_limited', null, 'GitHub calls for this installation are paused.', {
        retryAfterMs: paused - this.now(),
      });
    }
    let token = await this.tokens.installationToken(this.ref.githubInstallationId);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.http.request({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${token}` },
          schema,
          idempotent: true,
        });
      } catch (error) {
        if (error instanceof GithubApiError && error.kind === 'unauthorized' && attempt === 0) {
          token = await this.tokens.installationToken(this.ref.githubInstallationId, token);
          continue;
        }
        if (error instanceof GithubApiError && error.kind === 'rate_limited') {
          await this.coordination.pause(
            this.ref.installationRowId,
            this.now() + Math.max(1_000, error.retryAfterMs ?? DEFAULT_PAUSE_MS),
          );
        }
        throw error;
      }
    }
  }
}

/** Creates installation clients sharing one transport, token cache and coordination. */
export class GithubClientFactory {
  constructor(
    private readonly settings: Pick<GithubAppSettings, 'apiBaseUrl'>,
    private readonly http: GithubHttp,
    private readonly tokens: GithubTokenService,
    private readonly coordination: GithubCoordination,
  ) {}

  forInstallation(ref: InstallationRef): GithubInstallationClient {
    return new GithubInstallationClient(ref, this.settings, this.http, this.tokens, this.coordination);
  }
}
