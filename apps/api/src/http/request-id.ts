import { randomUUID } from 'node:crypto';

import { requestIdSchema } from '@company-ops/validation';

/** Accepts a client-supplied `X-Request-Id` only if it is a UUID; otherwise generates one (ARCHITECTURE §7). */
export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  if (candidate !== undefined && requestIdSchema.safeParse(candidate).success) {
    return candidate;
  }
  return randomUUID();
}
