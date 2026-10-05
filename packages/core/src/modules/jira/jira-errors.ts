import { ERROR_CODES } from '@company-ops/shared';

import { DomainError, NotFoundError } from '../../platform/errors.js';

/**
 * Classified outcome of a failed Jira or Atlassian auth call (INTEGRATIONS §1.9.6). Classification is
 * centralized here so retry, pause and re-auth decisions are made the same way everywhere.
 *
 * - `rate_limited`: 429, or 503 with Retry-After (Atlassian rate limiting).
 * - `unavailable`: other 5xx or a network failure. `timeout`: no response in time.
 * - `unauthorized`: 401 on an API call (access token rejected; one forced refresh is allowed).
 * - `reauth_required`: the refresh token was rejected (`invalid_grant`) or access was revoked.
 * - `forbidden`: 403, the connected account lacks a Jira permission.
 * - `not_found`: 404 (deleted, or not visible to the connected account).
 * - `invalid_request`: other 4xx (validation, bad JQL). `malformed`: a 2xx body we cannot parse.
 */
export type JiraFailureKind =
  | 'rate_limited'
  | 'unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'reauth_required'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'malformed';

const RETRYABLE: ReadonlySet<JiraFailureKind> = new Set(['rate_limited', 'unavailable', 'timeout']);

export class JiraApiError extends Error {
  readonly kind: JiraFailureKind;
  readonly status: number | null;
  /** Server-requested wait (Retry-After), when given. */
  readonly retryAfterMs: number | null;
  /** Field names Jira rejected (never their values). */
  readonly fields: readonly string[];

  constructor(
    kind: JiraFailureKind,
    status: number | null,
    message: string,
    options: { retryAfterMs?: number | null; fields?: readonly string[] } = {},
  ) {
    super(message);
    this.name = 'JiraApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.fields = options.fields ?? [];
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  /** Short code persisted on runs, failures and connections (`jira_<kind>`). */
  get code(): string {
    return `jira_${this.kind}`;
  }
}

/** Seconds (or an HTTP date) from a Retry-After header; null when absent or unparseable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
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

/** Maps a non-2xx Jira response to a classified error. Bodies are never copied into messages. */
export function classifyJiraResponse(
  status: number,
  headers: Headers,
  fields: readonly string[] = [],
  now: number = Date.now(),
): JiraApiError {
  const retryAfterMs = parseRetryAfter(headers.get('retry-after'), now);
  if (status === 429 || (status === 503 && retryAfterMs !== null)) {
    return new JiraApiError('rate_limited', status, 'Jira is rate limiting requests.', { retryAfterMs });
  }
  if (status >= 500) {
    return new JiraApiError('unavailable', status, `Jira responded with ${String(status)}.`, { retryAfterMs });
  }
  if (status === 401) {
    return new JiraApiError('unauthorized', status, 'Jira rejected the access token.');
  }
  if (status === 403) {
    return new JiraApiError('forbidden', status, 'The connected Jira account is not allowed to do this.');
  }
  if (status === 404) {
    return new JiraApiError('not_found', status, 'Not found in Jira.');
  }
  return new JiraApiError('invalid_request', status, `Jira rejected the request (${String(status)}).`, { fields });
}

export class JiraNotConfiguredError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.JIRA_NOT_CONFIGURED;

  constructor() {
    super('The Jira integration is not configured for this deployment.');
  }
}

export class JiraNotConnectedError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.JIRA_NOT_CONNECTED;

  constructor(message = 'Jira is not connected for this organization.') {
    super(message);
  }
}

export class JiraReauthRequiredError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.JIRA_REAUTH_REQUIRED;

  constructor() {
    super('The Jira connection needs to be re-authorized by an administrator.');
  }
}

export class JiraUnavailableError extends DomainError {
  readonly status = 503;
  readonly code = ERROR_CODES.JIRA_UNAVAILABLE;

  constructor(retryAfterMs: number | null) {
    super(
      'Jira is temporarily unavailable. Try again later.',
      retryAfterMs === null ? undefined : { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) },
    );
  }
}

export class JiraRequestRejectedError extends DomainError {
  readonly status = 422;
  readonly code = ERROR_CODES.JIRA_REQUEST_REJECTED;

  constructor(message: string, fields: readonly string[] = []) {
    super(message, fields.length === 0 ? undefined : { fields: [...fields] });
  }
}

export class JiraCreateOutcomeUnknownError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.JIRA_CREATE_OUTCOME_UNKNOWN;

  constructor() {
    super('An earlier attempt may already have created this Jira issue. Search Jira and link it instead.');
  }
}

export class JiraSyncInProgressError extends DomainError {
  readonly status = 409;
  readonly code = ERROR_CODES.JIRA_SYNC_IN_PROGRESS;

  constructor() {
    super('A sync is already queued or running for this mapping.');
  }
}

/** Caller-facing error for a failed interactive Jira call. */
export function toJiraDomainError(error: JiraApiError, resource = 'Jira resource'): DomainError {
  switch (error.kind) {
    case 'rate_limited':
    case 'unavailable':
    case 'timeout':
    case 'malformed':
      return new JiraUnavailableError(error.retryAfterMs);
    case 'unauthorized':
    case 'reauth_required':
      return new JiraReauthRequiredError();
    case 'not_found':
      return new NotFoundError(resource);
    case 'forbidden':
      return new JiraRequestRejectedError('The connected Jira account is not allowed to do this.');
    case 'invalid_request':
      return new JiraRequestRejectedError('Jira rejected the request.', error.fields);
  }
}
