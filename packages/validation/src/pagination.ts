import { z } from 'zod';

/** Opaque keyset cursor returned by list endpoints (ARCHITECTURE §8.2). */
export const cursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be an opaque cursor returned by the API');

export const pageQueryShape = {
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};

export const pageInfoSchema = z.strictObject({
  /** Pass as `cursor` to fetch the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});

/** `{ data: T[], page: { nextCursor } }`. */
export function pageResponseSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: z.array(item), page: pageInfoSchema });
}

/** `{ data: T[] }` for bounded lists (at most 500 rows). */
export function listResponseSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: z.array(item) });
}

export function dataResponseSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({ data: item });
}

export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** Boolean query flag (`true`/`false`); anything else is a validation error. */
export const booleanQuerySchema = z.enum(['true', 'false']).transform((value) => value === 'true');

export const idParamsSchema = z.strictObject({ id: z.uuid() });
export type IdParams = z.infer<typeof idParamsSchema>;
