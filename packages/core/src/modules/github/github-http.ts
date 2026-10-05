import { z } from 'zod';

import { classifyGithubResponse, GithubApiError, parseRateLimit } from './github-errors.js';
import type { RateLimitSnapshot } from './github-errors.js';

/** `fetch`-compatible function; injected so tests and the deterministic double need no network. */
export type GithubFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * REST API version sent on every call (`X-GitHub-Api-Version`). Verified 2026-10-03: 2026-03-10 is
 * the current version (2022-11-28 stays supported until 2028-03-10); none of its breaking changes
 * (`merge_commit_sha`, singular `assignee`, `rate` in /rate_limit) touch fields used here.
 */
export const GITHUB_API_VERSION = '2026-03-10';

const USER_AGENT = 'company-operations-github-app';
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export interface GithubHttpOptions {
  readonly fetch: GithubFetch;
  /** Per-attempt timeout. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt, for idempotent requests only. */
  readonly maxRetries?: number;
  /** Longest wait honoured inline; longer waits surface as `rate_limited` so callers can pause. */
  readonly maxInlineWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface GithubRequest<T> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Absolute URL (already validated against the configured base). */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  /** Safe to repeat. Token creation and code exchange are not retried here. */
  readonly idempotent: boolean;
  /** `application/json` instead of the GitHub media type (OAuth endpoints on the web host). */
  readonly plainJson?: boolean;
}

export interface GithubResponse<T> {
  readonly data: T;
  /** Absolute URL of the next page (same origin as the request), or null. */
  readonly next: string | null;
  readonly rateLimit: RateLimitSnapshot | null;
}

/** Exponential backoff with 0.7–1.3 jitter. */
export function githubBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const jitter = 0.7 + random() * 0.6;
  return Math.min(MAX_DELAY_MS, Math.round(BASE_DELAY_MS * 2 ** attempt * jitter));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The `rel="next"` URL of a Link header, only when it stays on the request's origin, so a forged or
 * unexpected header can never send credentials to another host.
 */
export function nextPageUrl(link: string | null, requestUrl: string): string | null {
  if (link === null) {
    return null;
  }
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part);
    if (match?.[2]?.split(/\s+/).includes('next') === true && match[1] !== undefined) {
      try {
        const next = new URL(match[1]);
        return next.origin === new URL(requestUrl).origin ? next.toString() : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function errorMessage(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
      return body.message.slice(0, 300);
    }
  } catch {
    // Not JSON: nothing to inspect.
    return null;
  }
  return null;
}

/**
 * Transport for GitHub REST calls: API version and media type headers, timeouts, centralized
 * classification (primary/secondary rate limits, Retry-After), bounded retries with jitter for
 * idempotent requests, same-origin pagination and response validation (a malformed 2xx body is an
 * error, never silently accepted). Never logs or echoes bodies, tokens or headers.
 */
export class GithubHttp {
  private readonly fetchFn: GithubFetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxInlineWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: GithubHttpOptions) {
    this.fetchFn = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxInlineWaitMs = options.maxInlineWaitMs ?? 10_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  async request<T>(request: GithubRequest<T>): Promise<GithubResponse<T>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once(request);
      } catch (error) {
        if (
          !(error instanceof GithubApiError) ||
          !error.retryable ||
          !request.idempotent ||
          attempt >= this.maxRetries
        ) {
          throw error;
        }
        const wait = error.retryAfterMs ?? githubBackoffDelay(attempt, this.random);
        if (wait > this.maxInlineWaitMs) {
          throw error;
        }
        await this.sleep(wait);
      }
    }
  }

  /** A request whose 2xx body is ignored (204 No Content). */
  async send(request: Omit<GithubRequest<unknown>, 'schema'>): Promise<void> {
    await this.request({ ...request, schema: z.unknown() });
  }

  private async once<T>(request: GithubRequest<T>): Promise<GithubResponse<T>> {
    const headers: Record<string, string> = {
      accept: request.plainJson === true ? 'application/json' : 'application/vnd.github+json',
      'user-agent': USER_AGENT,
      ...(request.plainJson === true ? {} : { 'x-github-api-version': GITHUB_API_VERSION }),
      ...request.headers,
    };
    const init: RequestInit = {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (request.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(request.body);
    }
    let response: Response;
    try {
      response = await this.fetchFn(request.url, init);
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw timedOut
        ? new GithubApiError('timeout', null, 'GitHub did not respond in time.')
        : new GithubApiError('unavailable', null, 'GitHub could not be reached.');
    }
    if (!response.ok) {
      const message = response.status === 403 || response.status === 429 ? await errorMessage(response) : null;
      if (message === null) {
        await response.body?.cancel();
      }
      throw classifyGithubResponse(response.status, response.headers, message, this.now());
    }
    const rateLimit = parseRateLimit(response.headers);
    const next = nextPageUrl(response.headers.get('link'), request.url);
    if (response.status === 204) {
      const empty = request.schema.safeParse(null);
      if (!empty.success) {
        throw new GithubApiError('malformed', 204, 'GitHub returned no content where a body was expected.');
      }
      return { data: empty.data, next, rateLimit };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GithubApiError('malformed', response.status, 'GitHub returned a response that is not JSON.');
    }
    const parsed = request.schema.safeParse(body);
    if (!parsed.success) {
      throw new GithubApiError('malformed', response.status, 'GitHub returned an unexpected response shape.');
    }
    return { data: parsed.data, next, rateLimit };
  }
}
