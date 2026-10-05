import type { z } from 'zod';

import { classifyJiraResponse, JiraApiError } from './jira-errors.js';

/** `fetch`-compatible function; injected so tests and the deterministic double need no network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JiraHttpOptions {
  readonly fetch: FetchLike;
  /** Per-attempt timeout. */
  readonly timeoutMs?: number;
  /** Retries after the first attempt, for idempotent requests only. */
  readonly maxRetries?: number;
  /** Longest server-requested wait honoured inline; longer waits surface as `rate_limited` to the caller. */
  readonly maxInlineWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export interface JiraRequest<T> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly schema: z.ZodType<T>;
  /**
   * Safe to repeat. Non-idempotent requests (issue create, token exchange) are never retried here,
   * because Jira has no idempotency key and a lost response may hide a success.
   */
  readonly idempotent: boolean;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
const MAX_ERROR_FIELDS = 20;

/** Exponential backoff with 0.7–1.3 jitter (Atlassian rate-limiting guidance). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const jitter = 0.7 + random() * 0.6;
  return Math.min(MAX_DELAY_MS, Math.round(BASE_DELAY_MS * 2 ** attempt * jitter));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Field names from a Jira error body (`{ errors: { field: message } }`); messages are dropped. */
async function rejectedFields(response: Response): Promise<string[]> {
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.errors)) {
      return Object.keys(body.errors)
        .filter((key) => /^[A-Za-z0-9_.-]{1,64}$/.test(key))
        .slice(0, MAX_ERROR_FIELDS);
    }
  } catch {
    // Not JSON: there are no field names to report.
    return [];
  }
  return [];
}

/**
 * Transport for Jira and Atlassian auth calls: timeouts, classification, bounded retries with
 * jitter for idempotent requests, Retry-After, and response validation (a malformed 2xx body is an
 * error, never silently accepted). Never logs or echoes bodies, URLs with codes, or headers.
 */
export class JiraHttp {
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxInlineWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: JiraHttpOptions) {
    this.fetchFn = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.maxInlineWaitMs = options.maxInlineWaitMs ?? 10_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /** A request whose 2xx body is validated with `request.schema`. */
  async request<T>(request: JiraRequest<T>): Promise<T> {
    const schema = request.schema;
    return this.withRetries(request, async (response) => {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new JiraApiError('malformed', response.status, 'Jira returned a response that is not JSON.');
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        throw new JiraApiError('malformed', response.status, 'Jira returned an unexpected response shape.');
      }
      return parsed.data;
    });
  }

  /** A request whose 2xx body is ignored (e.g. 204 No Content). */
  async send(request: Omit<JiraRequest<unknown>, 'schema'>): Promise<void> {
    await this.withRetries(request, async (response) => {
      await response.body?.cancel();
    });
  }

  private async withRetries<R>(
    request: Omit<JiraRequest<unknown>, 'schema'>,
    read: (response: Response) => Promise<R>,
  ): Promise<R> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await read(await this.once(request));
      } catch (error) {
        if (!(error instanceof JiraApiError) || !error.retryable || !request.idempotent || attempt >= this.maxRetries) {
          throw error;
        }
        const wait = error.retryAfterMs ?? backoffDelay(attempt, this.random);
        if (wait > this.maxInlineWaitMs) {
          throw error;
        }
        await this.sleep(wait);
      }
    }
  }

  private async once(request: Omit<JiraRequest<unknown>, 'schema'>): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json', ...request.headers };
    const init: RequestInit = { method: request.method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
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
        ? new JiraApiError('timeout', null, 'Jira did not respond in time.')
        : new JiraApiError('unavailable', null, 'Jira could not be reached.');
    }
    if (!response.ok) {
      const fields = response.status === 400 ? await rejectedFields(response) : [];
      throw classifyJiraResponse(response.status, response.headers, fields);
    }
    return response;
  }
}
