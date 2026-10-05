import { createApiClient } from '@company-ops/api-client';
import { CSRF_HEADER } from '@company-ops/shared';

/** Same-origin client: `/api/*` is forwarded to the API by the web server (src/proxy.ts). */
export const api = createApiClient('');

export interface ApiFieldError {
  readonly path: string;
  readonly code: string;
}

/** A failed API call, carrying the stable `error.code` the UI translates (UI_UX.md §5). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly fieldErrors: readonly ApiFieldError[];

  constructor(status: number, code: string, message: string, requestId: string | null, fieldErrors: ApiFieldError[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.fieldErrors = fieldErrors;
  }
}

interface ErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly requestId?: unknown;
    readonly fieldErrors?: unknown;
  };
}

function toApiError(response: Response, body: unknown): ApiError {
  const envelope = (typeof body === 'object' && body !== null ? body : {}) as ErrorBody;
  const error = envelope.error ?? {};
  const fieldErrors = Array.isArray(error.fieldErrors)
    ? error.fieldErrors.filter(
        (item): item is ApiFieldError =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Record<string, unknown>).path === 'string' &&
          typeof (item as Record<string, unknown>).code === 'string',
      )
    : [];
  return new ApiError(
    response.status,
    typeof error.code === 'string' ? error.code : 'UNKNOWN',
    typeof error.message === 'string' ? error.message : response.statusText,
    typeof error.requestId === 'string' ? error.requestId : response.headers.get('x-request-id'),
    fieldErrors,
  );
}

interface FetchResult<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

async function settle<T>(call: () => Promise<FetchResult<T>>): Promise<FetchResult<T>> {
  try {
    return await call();
  } catch (cause) {
    // The CSRF middleware's own request can fail with an API error (e.g. 401 once the session ended).
    if (cause instanceof ApiError) {
      throw cause;
    }
    throw new ApiError(0, 'NETWORK_ERROR', cause instanceof Error ? cause.message : 'network error', null, []);
  }
}

/** Resolves with the response body or throws an `ApiError`. A CSRF rejection refreshes the token and retries once. */
export async function request<T>(call: () => Promise<FetchResult<T>>): Promise<T> {
  let result = await settle(call);
  if (result.response.status === 403 && (result.error as ErrorBody | undefined)?.error?.code === 'CSRF_INVALID') {
    csrfToken = null;
    result = await settle(call);
  }
  if (!result.response.ok || result.error !== undefined) {
    throw toApiError(result.response, result.error);
  }
  if (result.data === undefined) {
    throw new ApiError(result.response.status, 'UNKNOWN', 'empty response', null, []);
  }
  return result.data;
}

/** For endpoints that answer 204 No Content. */
export async function requestEmpty(call: () => Promise<FetchResult<unknown>>): Promise<void> {
  let result = await settle(call);
  if (result.response.status === 403 && (result.error as ErrorBody | undefined)?.error?.code === 'CSRF_INVALID') {
    csrfToken = null;
    result = await settle(call);
  }
  if (!result.response.ok || result.error !== undefined) {
    throw toApiError(result.response, result.error);
  }
}

// ---- CSRF (SECURITY §4): synchronizer token bound to the session, sent on every unsafe method ----

let csrfToken: string | null = null;

/** Replaces the cached token (the API returns a new one when the session id rotates, e.g. on org switch). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function currentCsrfToken(): Promise<string> {
  if (csrfToken !== null) {
    return csrfToken;
  }
  const body = await request(() => api.GET('/api/v1/auth/csrf'));
  csrfToken = body.data.csrfToken;
  return csrfToken;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

api.use({
  async onRequest({ request: outgoing }) {
    if (!SAFE_METHODS.has(outgoing.method)) {
      outgoing.headers.set(CSRF_HEADER, await currentCsrfToken());
    }
    return outgoing;
  },
});
