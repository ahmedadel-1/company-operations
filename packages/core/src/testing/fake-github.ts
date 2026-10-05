import { createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Deterministic GitHub test double (ADR-0020). It implements only the documented contracts the
 * adapter uses — App JWT authentication, installation access tokens with `expires_at`, the REST
 * endpoints for installations, repositories, pull requests, reviews, check runs and combined status
 * (with `Link` pagination and rate-limit headers), the setup-time user OAuth flow, token revocation
 * and HMAC-SHA256 signed webhook deliveries — plus failure and rate-limit injection. It never talks
 * to GitHub. Used in process (through `fetch`) by integration tests and as an HTTP server with
 * `/__fake/*` control routes by end-to-end tests.
 */

export interface FakeGithubAccount {
  id: number;
  login: string;
  type: 'Organization' | 'User';
}

export interface FakeGithubInstallation {
  id: number;
  account: FakeGithubAccount;
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, string>;
  events: string[];
  suspendedAt: string | null;
  repoIds: number[];
  /** GitHub users (logins) who can see the installation through `GET /user/installations`. */
  userLogins: string[];
}

export interface FakeGithubRepo {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  /** Former full names (renames); requests by an old name are served like GitHub's redirect. */
  formerNames: string[];
}

export interface FakeGithubReview {
  id: number;
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  submittedAt: number;
}

export interface FakeGithubPull {
  id: number;
  repoId: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  created: number;
  updated: number;
  closed: number | null;
  requestedReviewers: string[];
  requestedTeams: string[];
  reviews: FakeGithubReview[];
}

export interface FakeCheckRun {
  id: number;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
}

export type FakeGithubFailureKind =
  | 'primary_rate_limit'
  | 'secondary_rate_limit'
  | 'server_error'
  | 'unavailable'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'malformed'
  | 'hang';

export interface FakeGithubFailure {
  /** Substring of `METHOD /path?query`, e.g. `GET /repos/acme-org/ops-platform/pulls`. */
  readonly match: string;
  readonly kind: FakeGithubFailureKind;
  times?: number;
  readonly retryAfterSeconds?: number;
}

export interface FakeGithubOptions {
  /** PEM of the App private key; the fake verifies App JWTs with its public half. */
  readonly privateKeyPem: string;
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly slug: string;
  readonly webhookSecret: string;
  /** Where webhooks are delivered and where the install flow returns (may be set later). */
  readonly webhookUrl?: string;
  readonly setupUrl?: string;
  readonly now?: () => number;
  readonly hangMs?: number;
  readonly deliver?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface FakeWebhookResult {
  readonly status: number;
  readonly deliveryId: string;
  readonly body: string;
}

const TOKEN_TTL_MS = 60 * 60 * 1000;
const RATE_LIMIT = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sha(seed: string): string {
  return createHmac('sha256', 'fake-github-sha').update(seed).digest('hex').slice(0, 40);
}

export class FakeGithub {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly slug: string;
  webhookSecret: string;
  webhookUrl: string | null;
  setupUrl: string | null;

  readonly installations = new Map<number, FakeGithubInstallation>();
  readonly repos = new Map<number, FakeGithubRepo>();
  readonly pulls = new Map<number, FakeGithubPull>();
  /** Check runs and commit statuses by head SHA. */
  readonly checkRuns = new Map<string, FakeCheckRun[]>();
  readonly statuses = new Map<string, string[]>();
  readonly failures: FakeGithubFailure[] = [];
  /** `METHOD /path?query` of every request, in order. */
  readonly requests: string[] = [];
  /** Installation tokens issued (`POST /app/installations/{id}/access_tokens`). */
  tokensIssued = 0;
  /** User tokens revoked through `DELETE /applications/{client_id}/token`. */
  revokedUserTokens = 0;
  /** The GitHub user who signs in during the OAuth step of setup. */
  currentUser = 'octo-admin';
  /** Remaining API budget reported in rate-limit headers. */
  rateRemaining = RATE_LIMIT;
  /** Installation used by the next `/apps/{slug}/installations/new` visit. */
  pendingInstallationId: number | null = null;

  private readonly publicKey: KeyObject;
  private readonly clock: () => number;
  private readonly hangMs: number;
  private readonly deliver: (url: string, init: RequestInit) => Promise<Response>;
  private readonly installationTokens = new Map<string, { installationId: number; expiresAt: number }>();
  private readonly userTokens = new Map<string, string>();
  private readonly codes = new Map<string, string>();
  private counter = 0;

  constructor(options: FakeGithubOptions) {
    this.publicKey = createPublicKey(options.privateKeyPem);
    this.appId = options.appId;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.slug = options.slug;
    this.webhookSecret = options.webhookSecret;
    this.webhookUrl = options.webhookUrl ?? null;
    this.setupUrl = options.setupUrl ?? null;
    this.clock = options.now ?? Date.now;
    this.hangMs = options.hangMs ?? 30_000;
    this.deliver = options.deliver ?? ((url, init) => fetch(url, init));
    this.reset();
  }

  /** Default fixture: one organization installation with three repositories and a few pull requests. */
  reset(): void {
    this.installations.clear();
    this.repos.clear();
    this.pulls.clear();
    this.checkRuns.clear();
    this.statuses.clear();
    this.failures.length = 0;
    this.requests.length = 0;
    this.installationTokens.clear();
    this.userTokens.clear();
    this.codes.clear();
    this.tokensIssued = 0;
    this.revokedUserTokens = 0;
    this.currentUser = 'octo-admin';
    this.rateRemaining = RATE_LIMIT;
    this.pendingInstallationId = 1001;
    this.counter = 0;
    const account: FakeGithubAccount = { id: 5001, login: 'acme-org', type: 'Organization' };
    this.addRepo({ id: 7001, owner: 'acme-org', name: 'ops-platform' });
    this.addRepo({ id: 7002, owner: 'acme-org', name: 'mobile-app' });
    this.addRepo({ id: 7003, owner: 'acme-org', name: 'website', private: false });
    this.installations.set(1001, {
      id: 1001,
      account,
      repositorySelection: 'selected',
      permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' },
      events: ['check_run', 'check_suite', 'pull_request', 'pull_request_review', 'repository', 'status'],
      suspendedAt: null,
      repoIds: [7001, 7002, 7003],
      userLogins: ['octo-admin'],
    });
    this.installations.set(2002, {
      id: 2002,
      account: { id: 6002, login: 'other-org', type: 'Organization' },
      repositorySelection: 'all',
      permissions: { metadata: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' },
      events: ['pull_request'],
      suspendedAt: null,
      repoIds: [],
      userLogins: ['other-admin'],
    });
    const day = 24 * 60 * 60 * 1000;
    const base = this.clock() - 5 * day;
    const first = this.addPull({
      repoId: 7001,
      title: 'Fix Safari login redirect',
      headRef: 'feature/OPS-1-safari-login',
      body: 'Restores the redirect after login.',
      created: base,
      requestedReviewers: ['reviewer-one'],
    });
    this.setChecks(first.headSha, [{ status: 'completed', conclusion: 'success' }], []);
    const second = this.addPull({
      repoId: 7001,
      title: 'Speed up CSV export',
      headRef: 'perf/export',
      body: 'Streams rows instead of buffering.\n\nRefs OPS-2',
      draft: true,
      created: base + day,
    });
    this.setChecks(second.headSha, [{ status: 'in_progress', conclusion: null }], []);
    this.addPull({
      repoId: 7001,
      title: 'Update dependencies',
      headRef: 'chore/deps',
      body: null,
      state: 'closed',
      merged: true,
      created: base - 20 * day,
    });
  }

  addRepo(input: Partial<FakeGithubRepo> & { id: number; owner: string; name: string }): FakeGithubRepo {
    const repo: FakeGithubRepo = {
      id: input.id,
      owner: input.owner,
      name: input.name,
      private: input.private ?? true,
      archived: input.archived ?? false,
      defaultBranch: input.defaultBranch ?? 'main',
      formerNames: input.formerNames ?? [],
    };
    this.repos.set(repo.id, repo);
    return repo;
  }

  addPull(
    input: Partial<Omit<FakeGithubPull, 'id' | 'number'>> & { repoId: number; title: string; number?: number },
  ): FakeGithubPull {
    const sameRepo = [...this.pulls.values()].filter((pull) => pull.repoId === input.repoId);
    const number = input.number ?? sameRepo.reduce((max, pull) => Math.max(max, pull.number), 0) + 1;
    const id = input.repoId * 1000 + number;
    const created = input.created ?? this.clock();
    const merged = input.merged ?? false;
    const state = input.state ?? (merged ? 'closed' : 'open');
    const pull: FakeGithubPull = {
      id,
      repoId: input.repoId,
      number,
      title: input.title,
      body: input.body ?? null,
      state,
      draft: input.draft ?? false,
      merged,
      author: input.author ?? 'dev-one',
      headRef: input.headRef ?? `branch-${String(number)}`,
      headSha: input.headSha ?? sha(`${String(id)}-0`),
      baseRef: input.baseRef ?? 'main',
      created,
      updated: input.updated ?? created + 60_000,
      closed: state === 'closed' ? (input.closed ?? created + 120_000) : null,
      requestedReviewers: input.requestedReviewers ?? [],
      requestedTeams: input.requestedTeams ?? [],
      reviews: input.reviews ?? [],
    };
    this.pulls.set(id, pull);
    return pull;
  }

  findPull(repoId: number, number: number): FakeGithubPull | null {
    return [...this.pulls.values()].find((pull) => pull.repoId === repoId && pull.number === number) ?? null;
  }

  /** Changes a pull request on "GitHub" (bumps `updated_at`; `push` moves the head commit). */
  updatePull(
    repoId: number,
    number: number,
    change: Partial<
      Pick<FakeGithubPull, 'title' | 'body' | 'state' | 'draft' | 'merged' | 'headRef' | 'requestedReviewers'>
    > & {
      push?: boolean;
    },
  ): FakeGithubPull {
    const pull = this.requirePull(repoId, number);
    const { push, ...fields } = change;
    Object.assign(pull, fields);
    if (push === true) {
      pull.headSha = sha(`${String(pull.id)}-${String(++this.counter)}`);
    }
    if (fields.merged === true) {
      pull.state = 'closed';
    }
    pull.closed = pull.state === 'closed' ? (pull.closed ?? this.clock()) : null;
    pull.updated = Math.max(this.clock(), pull.updated + 1000);
    return pull;
  }

  addReview(repoId: number, number: number, user: string, state: FakeGithubReview['state']): FakeGithubReview {
    const pull = this.requirePull(repoId, number);
    const review: FakeGithubReview = {
      id: 90000 + ++this.counter,
      user,
      state,
      submittedAt: Math.max(this.clock(), ...pull.reviews.map((existing) => existing.submittedAt + 1000)),
    };
    pull.reviews.push(review);
    pull.requestedReviewers = pull.requestedReviewers.filter((login) => login !== user);
    pull.updated = Math.max(this.clock(), pull.updated + 1000);
    return review;
  }

  setChecks(headSha: string, runs: Omit<FakeCheckRun, 'id'>[], statuses: string[]): void {
    this.checkRuns.set(
      headSha,
      runs.map((run) => ({ ...run, id: 80000 + ++this.counter })),
    );
    this.statuses.set(headSha, statuses);
  }

  suspend(installationId: number): void {
    this.requireInstallation(installationId).suspendedAt = iso(this.clock());
  }

  unsuspend(installationId: number): void {
    this.requireInstallation(installationId).suspendedAt = null;
  }

  uninstall(installationId: number): void {
    this.installations.delete(installationId);
    for (const [token, entry] of this.installationTokens) {
      if (entry.installationId === installationId) {
        this.installationTokens.delete(token);
      }
    }
  }

  removeRepo(installationId: number, repoId: number): void {
    const installation = this.requireInstallation(installationId);
    installation.repoIds = installation.repoIds.filter((id) => id !== repoId);
  }

  addRepoToInstallation(installationId: number, repoId: number): void {
    const installation = this.requireInstallation(installationId);
    if (!installation.repoIds.includes(repoId)) {
      installation.repoIds.push(repoId);
    }
  }

  renameRepo(repoId: number, name: string): void {
    const repo = this.repos.get(repoId);
    if (repo === undefined) {
      throw new Error(`Unknown fake repository ${String(repoId)}`);
    }
    repo.formerNames.push(`${repo.owner}/${repo.name}`);
    repo.name = name;
  }

  /** Invalidates every installation token (forces the adapter to mint new ones). */
  expireInstallationTokens(): void {
    this.installationTokens.clear();
  }

  fail(failure: FakeGithubFailure): void {
    this.failures.push({ ...failure, times: failure.times ?? 1 });
  }

  /**
   * Delivers a webhook signed with `X-Hub-Signature-256`. `deliveryId` lets tests replay a delivery;
   * `secret` signs with a different secret; `signature` overrides the header (null = omit it).
   */
  async sendWebhook(
    event: string,
    payload: Record<string, unknown>,
    options: { deliveryId?: string; secret?: string; signature?: string | null; tamper?: boolean } = {},
  ): Promise<FakeWebhookResult> {
    if (this.webhookUrl === null) {
      throw new Error('The fake GitHub has no webhook URL.');
    }
    const body = JSON.stringify(payload);
    const deliveryId =
      options.deliveryId ?? `fake-delivery-${String(++this.counter)}-${randomBytes(4).toString('hex')}`;
    const signature =
      options.signature === undefined
        ? `sha256=${createHmac('sha256', options.secret ?? this.webhookSecret)
            .update(body)
            .digest('hex')}`
        : options.signature;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/fake',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-github-hook-id': '424242',
      'x-github-hook-installation-target-type': 'integration',
      'x-github-hook-installation-target-id': this.appId,
    };
    if (signature !== null) {
      headers['x-hub-signature-256'] = signature;
    }
    const response = await this.deliver(this.webhookUrl, {
      method: 'POST',
      headers,
      body: options.tamper === true ? body.replace('"', '"tampered_') : body,
    });
    return { status: response.status, deliveryId, body: await response.text() };
  }

  /** Builds and sends a realistic payload for a pull request event. */
  async emitPullRequest(
    repoId: number,
    number: number,
    action: string,
    options: { deliveryId?: string } = {},
  ): Promise<FakeWebhookResult> {
    const pull = this.requirePull(repoId, number);
    const origin = 'https://github.com';
    return this.sendWebhook(
      'pull_request',
      {
        action,
        number,
        pull_request: this.pullWire(pull, origin),
        repository: this.repoWire(this.requireRepo(repoId), origin),
        installation: { id: this.installationOf(repoId) },
        sender: { login: pull.author },
      },
      options,
    );
  }

  async emitReview(repoId: number, number: number, action = 'submitted'): Promise<FakeWebhookResult> {
    const pull = this.requirePull(repoId, number);
    const review = pull.reviews.at(-1);
    return this.sendWebhook('pull_request_review', {
      action,
      review: review === undefined ? {} : { id: review.id, state: review.state.toLowerCase() },
      pull_request: this.pullWire(pull, 'https://github.com'),
      repository: this.repoWire(this.requireRepo(repoId), 'https://github.com'),
      installation: { id: this.installationOf(repoId) },
    });
  }

  async emitCheckRun(repoId: number, headSha: string, action = 'completed'): Promise<FakeWebhookResult> {
    return this.sendWebhook('check_run', {
      action,
      check_run: { id: 1, head_sha: headSha, status: 'completed' },
      repository: this.repoWire(this.requireRepo(repoId), 'https://github.com'),
      installation: { id: this.installationOf(repoId) },
    });
  }

  async emitStatus(repoId: number, headSha: string, state: string): Promise<FakeWebhookResult> {
    return this.sendWebhook('status', {
      sha: headSha,
      state,
      repository: this.repoWire(this.requireRepo(repoId), 'https://github.com'),
      installation: { id: this.installationOf(repoId) },
    });
  }

  async emitInstallation(installationId: number, action: string): Promise<FakeWebhookResult> {
    const installation = this.installations.get(installationId);
    return this.sendWebhook('installation', {
      action,
      installation: installation === undefined ? { id: installationId } : this.installationWire(installation),
    });
  }

  async emitInstallationRepositories(
    installationId: number,
    action: 'added' | 'removed',
    repoIds: number[],
  ): Promise<FakeWebhookResult> {
    const repos = repoIds.flatMap((id) => {
      const repo = this.repos.get(id);
      return repo === undefined ? [] : [{ id: repo.id, full_name: `${repo.owner}/${repo.name}` }];
    });
    return this.sendWebhook('installation_repositories', {
      action,
      installation: { id: installationId },
      [action === 'added' ? 'repositories_added' : 'repositories_removed']: repos,
    });
  }

  async emitRepository(repoId: number, action: string): Promise<FakeWebhookResult> {
    return this.sendWebhook('repository', {
      action,
      repository: this.repoWire(this.requireRepo(repoId), 'https://github.com'),
      installation: { id: this.installationOf(repoId) },
    });
  }

  /** `fetch`-compatible entry point for in-process use. */
  readonly fetch = (url: string, init: RequestInit = {}): Promise<Response> => this.handle(new Request(url, init));

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith('/__fake/')) {
      return this.control(request, path.slice('/__fake'.length));
    }
    const signature = `${request.method} ${path}${url.search}`;
    this.requests.push(signature);
    if (request.method === 'GET' && path === `/apps/${this.slug}/installations/new`) {
      return this.installFlow(url);
    }
    if (request.method === 'GET' && path === '/login/oauth/authorize') {
      return this.authorize(url);
    }
    if (request.method === 'POST' && path === '/login/oauth/access_token') {
      return this.exchange(await this.body(request));
    }
    const injected = await this.injectedFailure(signature, request.signal);
    if (injected !== null) {
      return injected;
    }
    return this.api(request, url);
  }

  private async api(request: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const method = request.method;
    let match: RegExpExecArray | null;
    if ((match = /^\/app\/installations\/([0-9]+)\/access_tokens$/.exec(path)) !== null && method === 'POST') {
      if (!this.validJwt(request)) {
        return this.error(401, 'A JSON web token could not be decoded');
      }
      const installation = this.installations.get(Number(match[1]));
      if (installation === undefined) {
        return this.error(404, 'Not Found');
      }
      if (installation.suspendedAt !== null) {
        return this.error(403, 'This installation has been suspended');
      }
      const token = `ghs_fake${randomBytes(8 + (++this.counter % 24)).toString('hex')}`;
      const expiresAt = this.clock() + TOKEN_TTL_MS;
      this.installationTokens.set(token, { installationId: installation.id, expiresAt });
      this.tokensIssued += 1;
      return this.json(201, {
        token,
        expires_at: iso(expiresAt),
        permissions: installation.permissions,
        repository_selection: installation.repositorySelection,
      });
    }
    if ((match = /^\/app\/installations\/([0-9]+)$/.exec(path)) !== null && method === 'GET') {
      if (!this.validJwt(request)) {
        return this.error(401, 'A JSON web token could not be decoded');
      }
      const installation = this.installations.get(Number(match[1]));
      return installation === undefined
        ? this.error(404, 'Not Found')
        : this.json(200, this.installationWire(installation));
    }
    if (method === 'GET' && path === '/user/installations') {
      const user = this.userTokens.get(this.bearer(request) ?? '');
      if (user === undefined) {
        return this.error(401, 'Bad credentials');
      }
      const visible = [...this.installations.values()].filter((installation) => installation.userLogins.includes(user));
      return this.paged(
        url,
        visible.map((installation) => this.installationWire(installation)),
        (items, total) => ({
          total_count: total,
          installations: items,
        }),
      );
    }
    if ((match = /^\/applications\/([^/]+)\/token$/.exec(path)) !== null && method === 'DELETE') {
      const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
      if (request.headers.get('authorization') !== expected || match[1] !== this.clientId) {
        return this.error(401, 'Bad credentials');
      }
      const body = await this.body(request);
      const token = isRecord(body) ? text(body.access_token) : null;
      if (token !== null && this.userTokens.delete(token)) {
        this.revokedUserTokens += 1;
      }
      return new Response(null, { status: 204 });
    }
    const installation = this.tokenInstallation(request);
    if (installation === null) {
      return this.error(401, 'Bad credentials');
    }
    if (method === 'GET' && path === '/installation/repositories') {
      const repos = installation.repoIds.flatMap((id) => {
        const repo = this.repos.get(id);
        return repo === undefined ? [] : [this.repoWire(repo, url.origin)];
      });
      return this.paged(url, repos, (items, total) => ({ total_count: total, repositories: items }));
    }
    if ((match = /^\/repositories\/([0-9]+)$/.exec(path)) !== null && method === 'GET') {
      const repo = this.repos.get(Number(match[1]));
      return repo === undefined || !installation.repoIds.includes(repo.id)
        ? this.error(404, 'Not Found')
        : this.json(200, this.repoWire(repo, url.origin));
    }
    const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)$/.exec(path);
    if (repoMatch === null || method !== 'GET') {
      return this.error(404, 'Not Found');
    }
    const fullName = `${decodeURIComponent(repoMatch[1] ?? '')}/${decodeURIComponent(repoMatch[2] ?? '')}`;
    const repo = [...this.repos.values()].find(
      (candidate) => `${candidate.owner}/${candidate.name}` === fullName || candidate.formerNames.includes(fullName),
    );
    if (repo === undefined || !installation.repoIds.includes(repo.id)) {
      return this.error(404, 'Not Found');
    }
    const rest = repoMatch[3] ?? '';
    if (rest === '/pulls') {
      return this.listPulls(url, repo);
    }
    if ((match = /^\/pulls\/([0-9]+)$/.exec(rest)) !== null) {
      const pull = this.findPull(repo.id, Number(match[1]));
      return pull === null ? this.error(404, 'Not Found') : this.json(200, this.pullWire(pull, url.origin));
    }
    if ((match = /^\/pulls\/([0-9]+)\/reviews$/.exec(rest)) !== null) {
      const pull = this.findPull(repo.id, Number(match[1]));
      if (pull === null) {
        return this.error(404, 'Not Found');
      }
      const reviews = pull.reviews.map((review) => ({
        id: review.id,
        user: { login: review.user },
        state: review.state,
        submitted_at: review.state === 'PENDING' ? null : iso(review.submittedAt),
      }));
      return this.paged(url, reviews, (items) => items);
    }
    if ((match = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest)) !== null) {
      const runs = (this.checkRuns.get(match[1] ?? '') ?? []).map((run) => ({
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
      }));
      return this.paged(url, runs, (items, total) => ({ total_count: total, check_runs: items }));
    }
    if ((match = /^\/commits\/([0-9a-f]+)\/status$/.exec(rest)) !== null) {
      const statuses = this.statuses.get(match[1] ?? '') ?? [];
      const state =
        statuses.includes('failure') || statuses.includes('error')
          ? 'failure'
          : statuses.includes('pending') || statuses.length === 0
            ? 'pending'
            : 'success';
      return this.json(200, { state, total_count: statuses.length, statuses: statuses.map((s) => ({ state: s })) });
    }
    return this.error(404, 'Not Found');
  }

  private listPulls(url: URL, repo: FakeGithubRepo): Response {
    const state = url.searchParams.get('state') ?? 'open';
    const sort = url.searchParams.get('sort') ?? 'created';
    const direction = url.searchParams.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
    const sign = direction === 'asc' ? 1 : -1;
    const pulls = [...this.pulls.values()]
      .filter((pull) => pull.repoId === repo.id && (state === 'all' || pull.state === state))
      .sort((a, b) => {
        const key = sort === 'updated' ? a.updated - b.updated : a.created - b.created;
        return sign * (key === 0 ? a.number - b.number : key);
      })
      .map((pull) => this.pullWire(pull, url.origin));
    return this.paged(url, pulls, (items) => items);
  }

  private paged<T>(url: URL, items: T[], shape: (page: T[], total: number) => unknown): Response {
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers: Record<string, string> = {};
    const last = Math.max(1, Math.ceil(items.length / perPage));
    if (page < last) {
      const next = new URL(url.toString());
      next.searchParams.set('page', String(page + 1));
      const lastUrl = new URL(url.toString());
      lastUrl.searchParams.set('page', String(last));
      headers.link = `<${next.toString()}>; rel="next", <${lastUrl.toString()}>; rel="last"`;
    }
    return this.json(200, shape(slice, items.length), headers);
  }

  private installFlow(url: URL): Response {
    const state = url.searchParams.get('state') ?? '';
    const installationId = this.pendingInstallationId;
    if (this.setupUrl === null || installationId === null) {
      return this.error(400, 'The fake GitHub has no setup URL or pending installation.');
    }
    const target = new URL(this.setupUrl);
    target.searchParams.set('installation_id', String(installationId));
    target.searchParams.set('setup_action', 'install');
    target.searchParams.set('state', state);
    return new Response(null, { status: 302, headers: { location: target.toString() } });
  }

  private authorize(url: URL): Response {
    const redirect = url.searchParams.get('redirect_uri');
    if (redirect === null || url.searchParams.get('client_id') !== this.clientId) {
      return this.error(400, 'redirect_uri and client_id are required');
    }
    const code = `fake-code-${String(++this.counter)}`;
    this.codes.set(code, this.currentUser);
    const target = new URL(redirect);
    target.searchParams.set('code', code);
    target.searchParams.set('state', url.searchParams.get('state') ?? '');
    return new Response(null, { status: 302, headers: { location: target.toString() } });
  }

  private exchange(body: unknown): Response {
    if (!isRecord(body) || body.client_id !== this.clientId || body.client_secret !== this.clientSecret) {
      return this.json(200, { error: 'incorrect_client_credentials' });
    }
    const code = text(body.code) ?? '';
    const user = this.codes.get(code);
    if (user === undefined) {
      return this.json(200, { error: 'bad_verification_code' });
    }
    this.codes.delete(code);
    const token = `ghu_fake${randomBytes(12).toString('hex')}`;
    this.userTokens.set(token, user);
    return this.json(200, { access_token: token, token_type: 'bearer', scope: '' });
  }

  private validJwt(request: Request): boolean {
    const token = this.bearer(request);
    const parts = token?.split('.') ?? [];
    if (parts.length !== 3) {
      return false;
    }
    const [header = '', payload = '', signature = ''] = parts;
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      this.publicKey,
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) {
      return false;
    }
    try {
      const head: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
      const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!isRecord(head) || head.alg !== 'RS256' || !isRecord(claims)) {
        return false;
      }
      const iat = num(claims.iat);
      const exp = num(claims.exp);
      const iss = claims.iss;
      const nowSeconds = Math.floor(this.clock() / 1000);
      return (
        iat !== null &&
        exp !== null &&
        exp > nowSeconds &&
        iat <= nowSeconds + 60 &&
        exp - iat <= 600 &&
        (iss === this.clientId || iss === this.appId || iss === Number(this.appId))
      );
    } catch {
      return false;
    }
  }

  private bearer(request: Request): string | null {
    const header = request.headers.get('authorization') ?? '';
    const match = /^(?:Bearer|token) (.+)$/.exec(header);
    return match?.[1] ?? null;
  }

  private tokenInstallation(request: Request): FakeGithubInstallation | null {
    const entry = this.installationTokens.get(this.bearer(request) ?? '');
    if (entry === undefined || entry.expiresAt <= this.clock()) {
      return null;
    }
    return this.installations.get(entry.installationId) ?? null;
  }

  private async injectedFailure(signature: string, signal: AbortSignal): Promise<Response | null> {
    const index = this.failures.findIndex((failure) => signature.includes(failure.match));
    const failure = this.failures[index];
    if (failure === undefined) {
      return null;
    }
    failure.times = (failure.times ?? 1) - 1;
    if (failure.times <= 0) {
      this.failures.splice(index, 1);
    }
    const reset = Math.floor(this.clock() / 1000) + (failure.retryAfterSeconds ?? 60);
    switch (failure.kind) {
      case 'primary_rate_limit':
        return this.json(
          403,
          { message: 'API rate limit exceeded for installation.' },
          { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
          true,
        );
      case 'secondary_rate_limit':
        return this.json(
          403,
          { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
          failure.retryAfterSeconds === undefined ? {} : { 'retry-after': String(failure.retryAfterSeconds) },
        );
      case 'server_error':
        return this.error(500, 'Server Error');
      case 'unavailable':
        return this.json(
          503,
          { message: 'Service Unavailable' },
          failure.retryAfterSeconds === undefined ? {} : { 'retry-after': String(failure.retryAfterSeconds) },
        );
      case 'unauthorized':
        return this.error(401, 'Bad credentials');
      case 'forbidden':
        return this.error(403, 'Resource not accessible by integration');
      case 'not_found':
        return this.error(404, 'Not Found');
      case 'malformed':
        return new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      case 'hang':
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.hangMs);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return this.error(504, 'Gateway Timeout');
    }
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}, exhausted = false): Response {
    if (!exhausted && this.rateRemaining > 0) {
      this.rateRemaining -= 1;
    }
    const reset = Math.floor(this.clock() / 1000) + 3600;
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-github-media-type': 'github.v3; format=json',
        'x-ratelimit-limit': String(RATE_LIMIT),
        'x-ratelimit-remaining': String(exhausted ? 0 : this.rateRemaining),
        'x-ratelimit-used': String(RATE_LIMIT - this.rateRemaining),
        'x-ratelimit-reset': String(reset),
        'x-ratelimit-resource': 'core',
        ...headers,
      },
    });
  }

  private error(status: number, message: string): Response {
    return this.json(status, { message, documentation_url: 'https://docs.github.com/rest', status: String(status) });
  }

  installationWire(installation: FakeGithubInstallation): Record<string, unknown> {
    return {
      id: installation.id,
      app_id: Number(this.appId),
      account: { id: installation.account.id, login: installation.account.login, type: installation.account.type },
      target_type: installation.account.type,
      repository_selection: installation.repositorySelection,
      permissions: installation.permissions,
      events: installation.events,
      suspended_at: installation.suspendedAt,
    };
  }

  repoWire(repo: FakeGithubRepo, origin: string): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: `R_fake${String(repo.id)}`,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      archived: repo.archived,
      default_branch: repo.defaultBranch,
      html_url: `${origin}/${repo.owner}/${repo.name}`,
    };
  }

  pullWire(pull: FakeGithubPull, origin: string): Record<string, unknown> {
    const repo = this.requireRepo(pull.repoId);
    return {
      id: pull.id,
      node_id: `PR_fake${String(pull.id)}`,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      draft: pull.draft,
      merged_at: pull.merged && pull.closed !== null ? iso(pull.closed) : null,
      closed_at: pull.closed === null ? null : iso(pull.closed),
      created_at: iso(pull.created),
      updated_at: iso(pull.updated),
      user: { login: pull.author },
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef },
      html_url: `${origin}/${repo.owner}/${repo.name}/pull/${String(pull.number)}`,
      requested_reviewers: pull.requestedReviewers.map((login) => ({ login })),
      requested_teams: pull.requestedTeams.map((slug) => ({ slug })),
    };
  }

  private installationOf(repoId: number): number {
    for (const installation of this.installations.values()) {
      if (installation.repoIds.includes(repoId)) {
        return installation.id;
      }
    }
    return 1001;
  }

  private requireInstallation(id: number): FakeGithubInstallation {
    const installation = this.installations.get(id);
    if (installation === undefined) {
      throw new Error(`Unknown fake installation ${String(id)}`);
    }
    return installation;
  }

  private requireRepo(id: number): FakeGithubRepo {
    const repo = this.repos.get(id);
    if (repo === undefined) {
      throw new Error(`Unknown fake repository ${String(id)}`);
    }
    return repo;
  }

  private requirePull(repoId: number, number: number): FakeGithubPull {
    const pull = this.findPull(repoId, number);
    if (pull === null) {
      throw new Error(`Unknown fake pull request ${String(repoId)}#${String(number)}`);
    }
    return pull;
  }

  private async control(request: Request, path: string): Promise<Response> {
    const body = await this.body(request);
    const record = isRecord(body) ? body : {};
    if (request.method === 'GET' && path === '/state') {
      return this.json(200, {
        tokensIssued: this.tokensIssued,
        revokedUserTokens: this.revokedUserTokens,
        requests: this.requests,
        installations: [...this.installations.values()].map((installation) => ({
          id: installation.id,
          suspendedAt: installation.suspendedAt,
          repoIds: installation.repoIds,
        })),
        pulls: [...this.pulls.values()].map((pull) => ({
          repoId: pull.repoId,
          number: pull.number,
          title: pull.title,
          headSha: pull.headSha,
          state: pull.state,
        })),
      });
    }
    if (request.method !== 'POST') {
      return this.json(405, { error: 'method' });
    }
    const repoId = num(record.repoId) ?? 7001;
    const number = num(record.number);
    const installationId = num(record.installationId) ?? 1001;
    try {
      switch (path) {
        case '/reset':
          this.reset();
          return this.json(200, { ok: true });
        case '/config':
          if (text(record.webhookUrl) !== null) {
            this.webhookUrl = text(record.webhookUrl);
          }
          if (text(record.setupUrl) !== null) {
            this.setupUrl = text(record.setupUrl);
          }
          if (text(record.currentUser) !== null) {
            this.currentUser = text(record.currentUser) ?? this.currentUser;
          }
          if (num(record.pendingInstallationId) !== null) {
            this.pendingInstallationId = num(record.pendingInstallationId);
          }
          return this.json(200, { ok: true });
        case '/fail': {
          const kinds: readonly FakeGithubFailureKind[] = [
            'primary_rate_limit',
            'secondary_rate_limit',
            'server_error',
            'unavailable',
            'unauthorized',
            'forbidden',
            'not_found',
            'malformed',
            'hang',
          ];
          const kind = kinds.find((candidate) => candidate === record.kind);
          const match = text(record.match);
          if (kind === undefined || match === null) {
            return this.json(400, { error: 'kind and match are required' });
          }
          this.fail({
            match,
            kind,
            times: num(record.times) ?? 1,
            ...(num(record.retryAfterSeconds) === null
              ? {}
              : { retryAfterSeconds: num(record.retryAfterSeconds) ?? 0 }),
          });
          return this.json(200, { ok: true });
        }
        case '/pulls': {
          const pull = this.addPull({
            repoId,
            title: text(record.title) ?? 'Fake pull request',
            ...(text(record.headRef) === null ? {} : { headRef: text(record.headRef) ?? '' }),
            ...(text(record.body) === null ? {} : { body: text(record.body) }),
            ...(record.draft === true ? { draft: true } : {}),
          });
          if (Array.isArray(record.checks)) {
            this.setChecks(
              pull.headSha,
              record.checks.map((conclusion) => ({ status: 'completed' as const, conclusion: String(conclusion) })),
              [],
            );
          }
          return this.json(200, { number: pull.number, headSha: pull.headSha });
        }
        case '/pulls/update': {
          if (number === null) {
            return this.json(400, { error: 'number' });
          }
          const pull = this.updatePull(repoId, number, {
            ...(text(record.title) === null ? {} : { title: text(record.title) ?? '' }),
            ...(record.state === 'open' || record.state === 'closed' ? { state: record.state } : {}),
            ...(typeof record.draft === 'boolean' ? { draft: record.draft } : {}),
            ...(record.merged === true ? { merged: true } : {}),
            ...(record.push === true ? { push: true } : {}),
          });
          return this.json(200, { number: pull.number, headSha: pull.headSha });
        }
        case '/reviews': {
          const state = record.state;
          if (
            number === null ||
            (state !== 'APPROVED' && state !== 'CHANGES_REQUESTED' && state !== 'COMMENTED' && state !== 'DISMISSED')
          ) {
            return this.json(400, { error: 'number and state' });
          }
          this.addReview(repoId, number, text(record.user) ?? 'reviewer-one', state);
          return this.json(200, { ok: true });
        }
        case '/checks': {
          if (number === null || !Array.isArray(record.conclusions)) {
            return this.json(400, { error: 'number and conclusions' });
          }
          const pull = this.requirePull(repoId, number);
          this.setChecks(
            pull.headSha,
            record.conclusions.map((conclusion) =>
              conclusion === null || conclusion === 'pending'
                ? { status: 'in_progress' as const, conclusion: null }
                : { status: 'completed' as const, conclusion: String(conclusion) },
            ),
            Array.isArray(record.statuses) ? record.statuses.map(String) : [],
          );
          return this.json(200, { headSha: pull.headSha });
        }
        case '/installations/suspend':
          this.suspend(installationId);
          return this.json(200, { ok: true });
        case '/installations/unsuspend':
          this.unsuspend(installationId);
          return this.json(200, { ok: true });
        case '/installations/delete':
          this.uninstall(installationId);
          return this.json(200, { ok: true });
        case '/repos/remove':
          this.removeRepo(installationId, repoId);
          return this.json(200, { ok: true });
        case '/repos/add':
          this.addRepoToInstallation(installationId, repoId);
          return this.json(200, { ok: true });
        case '/repos/rename': {
          const name = text(record.name);
          if (name === null) {
            return this.json(400, { error: 'name' });
          }
          this.renameRepo(repoId, name);
          return this.json(200, { ok: true });
        }
        case '/webhooks/emit': {
          const event = text(record.event);
          const action = text(record.action) ?? '';
          let result: FakeWebhookResult;
          if (event === 'pull_request' && number !== null) {
            result = await this.emitPullRequest(repoId, number, action || 'synchronize');
          } else if (event === 'pull_request_review' && number !== null) {
            result = await this.emitReview(repoId, number, action || 'submitted');
          } else if (event === 'check_run' && number !== null) {
            result = await this.emitCheckRun(repoId, this.requirePull(repoId, number).headSha, action || 'completed');
          } else if (event === 'installation') {
            result = await this.emitInstallation(installationId, action || 'created');
          } else if (event === 'installation_repositories') {
            result = await this.emitInstallationRepositories(installationId, action === 'added' ? 'added' : 'removed', [
              repoId,
            ]);
          } else if (event === 'repository') {
            result = await this.emitRepository(repoId, action || 'edited');
          } else {
            return this.json(400, { error: 'unsupported event' });
          }
          return this.json(200, result);
        }
        default:
          return this.json(404, { error: 'unknown control route' });
      }
    } catch (error) {
      return this.json(400, { error: error instanceof Error ? error.message : 'error' });
    }
  }

  private async body(request: Request): Promise<unknown> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      return null;
    }
    const raw = await request.text();
    if (raw === '') {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed;
    } catch {
      return null;
    }
  }
}

async function toRequest(message: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  const method = message.method ?? 'GET';
  return new Request(new URL(message.url ?? '/', origin), {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function respond(response: Response, out: ServerResponse): Promise<void> {
  out.statusCode = response.status;
  response.headers.forEach((value, name) => {
    out.setHeader(name, value);
  });
  out.end(Buffer.from(await response.arrayBuffer()));
}

export interface FakeGithubServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Serves the fake over HTTP on 127.0.0.1 (port 0 = any free port). */
export async function startFakeGithubServer(fake: FakeGithub, port = 0): Promise<FakeGithubServer> {
  let origin = '';
  const server: Server = createServer((message, out) => {
    toRequest(message, origin)
      .then((request) => fake.handle(request))
      .then((response) => respond(response, out))
      .catch(() => {
        out.statusCode = 500;
        out.end();
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fake GitHub server has no TCP address.');
  }
  origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
