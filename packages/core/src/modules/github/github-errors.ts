import { ERROR_CODES } from '@company-ops/shared';

import { DomainError, NotFoundError } from '../../platform/errors.js';

/**
 * Classified outcome of a failed GitHub call (INTEGRATIONS §2.6). Classification is centralized here
 * so retry, pause and status decisions are made the same way everywhere.
 *
 * - `rate_limited`: primary limit exhausted (403/429 with `x-ratelimit-remaining: 0`) or a secondary
 *   limit (403/429 with `retry-after` or GitHub's secondary-limit message).
 * - `unavailable`: 5xx or a network failure. `timeout`: no response in time.
 * - `unauthorized`: 401 (JWT or installation token rejected; one forced token renewal is allowed).
 * - `forbidden`: other 403 (the app lacks a permission, or the installation is suspended).
 * - `not_found`: 404 (deleted, or not visible to the installation). `gone`: 410 (API version retired).
 * - `invalid_request`: other 4xx. `malformed`: a 2xx body we cannot parse.
 */
export type GithubFailureKind =
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'gone'
  | 'invalid_request'
  | 'malformed';

const RETRYABLE: ReadonlySet<GithubFailureKind> = new Set(['rate_limited', 'unavailable', 'timeout']);

/** Rate-limit headers of a response (diagnostics only; never a token or body). */
export interface RateLimitSnapshot {
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly used: number | null;
  /** Epoch ms when the window resets. */
  readonly resetAt: number | null;
  readonly resource: string | null;
}

/** Wait for a secondary limit when GitHub does not say how long (docs: at least one minute). */
export const SECONDARY_LIMIT_WAIT_MS = 60_000;

export class GithubApiError extends Error {
  readonly kind: GithubFailureKind;
  readonly status: number | null;
  /** How long GitHub asked us to wait (Retry-After, or until the primary window resets). */
  readonly retryAfterMs: number | null;
  readonly rateLimit: RateLimitSnapshot | null;

  constructor(
    kind: GithubFailureKind,
    status: number | null,
    message: string,
    options: { retryAfterMs?: number | null; rateLimit?: RateLimitSnapshot | null } = {},
  ) {
    super(message);
    this.name = 'GithubApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.rateLimit = options.rateLimit ?? null;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /** Short code persisted on runs, failures, deliveries and installations (`github_<kind>`). */
  get code(): string {
    return `github_${this.kind}`;
  }
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') {
    return null;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function parseRateLimit(headers: Headers): RateLimitSnapshot | null {
  const limit = headerNumber(headers, 'x-ratelimit-limit');
  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const reset = headerNumber(headers, 'x-ratelimit-reset');
  if (limit === null && remaining === null && reset === null) {
    return null;
  }
  const resource = headers.get('x-ratelimit-resource');
  return {
    limit,
    remaining,
    used: headerNumber(headers, 'x-ratelimit-used'),
    resetAt: reset === null ? null : reset * 1000,
    resource: resource !== null && /^[a-z_]{1,40}$/.test(resource) ? resource : null,
  };
}

/** Seconds (or an HTTP date) from a Retry-After header; null when absent or unparseable. */
export function parseGithubRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Maps a non-2xx GitHub response to a classified error. `message` is GitHub's `message` field, used
 * only to recognise a secondary rate limit; bodies are never copied into errors.
 */
export function classifyGithubResponse(
  status: number,
  headers: Headers,
  message: string | null,
  now: number = Date.now(),
): GithubApiError {
  const rateLimit = parseRateLimit(headers);
  const retryAfter = parseGithubRetryAfter(headers.get('retry-after'), now);
  if (status === 403 || status === 429) {
    if (rateLimit?.remaining === 0 && rateLimit.resetAt !== null) {
      return new GithubApiError('rate_limited', status, 'GitHub rate limit exhausted.', {
        retryAfterMs: retryAfter ?? Math.max(1_000, rateLimit.resetAt - now + 1_000),
        rateLimit,
      });
    }
    if (retryAfter !== null || status === 429 || (message !== null && /secondary rate limit|abuse/i.test(message))) {
      return new GithubApiError('rate_limited', status, 'GitHub secondary rate limit.', {
        retryAfterMs: retryAfter ?? SECONDARY_LIMIT_WAIT_MS,
        rateLimit,
      });
    }
    return new GithubApiError('forbidden', status, 'GitHub refused access for this app or installation.', {
      rateLimit,
    });
  }
  if (status >= 500) {
    return new GithubApiError('unavailable', status, `GitHub responded with ${String(status)}.`, {
      retryAfterMs: retryAfter,
      rateLimit,
    });
  }
  if (status === 401) {
    return new GithubApiError('unauthorized', status, 'GitHub rejected the app credentials.', { rateLimit });
  }
  if (status === 404) {
    return new GithubApiError('not_found', status, 'Not found on GitHub.', { rateLimit });
  }
  if (status === 410) {
    return new GithubApiError('gone', status, 'GitHub no longer serves this resource or API version.', { rateLimit });
  }
  return new GithubApiError('invalid_request', status, `GitHub rejected the request (${String(status)}).`, {
    rateLimit,
  });
}

export class GithubNotConfiguredError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.GITHUB_NOT_CONFIGURED;

  constructor() {
    super('The GitHub integration is not configured for this deployment.');
  }
}

export class GithubSetupInvalidError extends DomainError {
  readonly status = 403;
  readonly code = ERROR_CODES.GITHUB_SETUP_INVALID;

  constructor(message = 'The GitHub installation could not be verified. Start again from the admin page.') {
    super(message);
  }
}

export class GithubInstallationConflictError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.GITHUB_INSTALLATION_CONFLICT;

  constructor() {
    super('This GitHub installation is already connected to another organization.');
  }
}

export class GithubInstallationInactiveError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.GITHUB_INSTALLATION_INACTIVE;

  constructor(message = 'The GitHub installation or repository is not active.') {
    super(message);
  }
}

export class GithubUnavailableError extends DomainError {
  readonly status = 503;
  readonly code = ERROR_CODES.GITHUB_UNAVAILABLE;

  constructor(retryAfterMs: number | null) {
    super(
      'GitHub is temporarily unavailable. Try again later.',
      retryAfterMs === null ? undefined : { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
    );
  }
}

export class GithubRequestRejectedError extends DomainError {
  readonly status = 422;
  readonly code = ERROR_CODES.GITHUB_REQUEST_REJECTED;
}

export class GithubSyncInProgressError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.GITHUB_SYNC_IN_PROGRESS;

  constructor() {
    super('A sync is already queued or running for this repository.');
  }
}

/** Caller-facing error for a failed interactive GitHub call. */
export function toGithubDomainError(error: GithubApiError, resource = 'GitHub resource'): DomainError {
  switch (error.kind) {
    case 'rate_limited':
    case 'unavailable':
    case 'timeout':
    case 'malformed':
    case 'gone':
      return new GithubUnavailableError(error.retryAfterMs);
    case 'not_found':
      return new NotFoundError(resource);
    case 'unauthorized':
    case 'forbidden':
      return new GithubRequestRejectedError('GitHub refused access for this app or installation.');
    case 'invalid_request':
      return new GithubRequestRejectedError('GitHub rejected the request.');
  }
}
