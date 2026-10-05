import { z } from 'zod';

/** Client-supplied correlation IDs are accepted only when they are UUIDs (ARCHITECTURE §7). */
export const requestIdSchema = z.uuid();

export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
});

/** Error envelope returned by every API error response (ARCHITECTURE §8.1). */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    fieldErrors: z.array(fieldErrorSchema).optional(),
    requestId: z.string(),
  }),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** The parsed (output) type of a contract schema, for consumers without a direct zod dependency. */
export type SchemaOutput<T extends z.ZodType> = z.output<T>;
