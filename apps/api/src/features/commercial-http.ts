import { InvalidInputError } from '@company-ops/core';
import type { Page } from '@company-ops/core';
import { commercialIdempotencyKeySchema } from '@company-ops/validation';

import type { HttpRequest } from '../http/http-types.js';

export interface PageBody<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null };
}

export const toPage = <T>(page: Page<T>): PageBody<T> => ({ data: page.items, page: { nextCursor: page.nextCursor } });

/** Submissions, tender-to-contract conversion and renewal decisions are replay-safe by client key. */
export const COMMERCIAL_IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: 'UUID chosen by the client; a retry with the same key returns the original result.',
} as const;

export function requiredIdempotencyKey(request: HttpRequest): string {
  const raw = request.headers['idempotency-key'];
  if (raw === undefined) {
    throw new InvalidInputError('Idempotency-Key', 'The Idempotency-Key header is required.');
  }
  const parsed = commercialIdempotencyKeySchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!parsed.success) {
    throw new InvalidInputError('Idempotency-Key', 'The Idempotency-Key header must be a UUID.');
  }
  return parsed.data;
}
