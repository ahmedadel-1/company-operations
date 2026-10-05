import createClient from 'openapi-fetch';

import type { paths } from './generated/schema.js';

export type { paths };

export type ApiClient = ReturnType<typeof createClient<paths>>;

/** Typed client for the `/api/v1` contract generated from the API's OpenAPI document. */
export function createApiClient(baseUrl: string): ApiClient {
  return createClient<paths>({ baseUrl });
}
