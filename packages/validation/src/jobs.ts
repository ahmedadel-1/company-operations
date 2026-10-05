import { z } from 'zod';

import { isoDateTimeSchema, listResponseSchema } from './pagination.js';

/**
 * Failed background work of the active organization (P1-15): queue jobs that exhausted their
 * attempts or failed permanently, and outbox events the relay gave up on. Error messages are
 * truncated and never contain payload values.
 */
export const failedJobSchema = z.strictObject({
  source: z.enum(['queue', 'outbox']),
  id: z.string(),
  queue: z.string().nullable(),
  name: z.string(),
  attempts: z.number().int(),
  error: z.string().nullable(),
  failedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export const failedJobListResponseSchema = listResponseSchema(failedJobSchema);

export type FailedJob = z.infer<typeof failedJobSchema>;
