import { InvalidInputError } from '../errors.js';

/**
 * Opaque keyset cursors (ARCHITECTURE §8.2): base64url JSON of the last row's sort key values.
 * The cursor only positions a query that is already bound to the organization and the caller's
 * scope, so a forged cursor can skip rows but never reveal rows outside that query.
 */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function encodeCursor(values: readonly string[]): string {
  return Buffer.from(JSON.stringify(values), 'utf8').toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decodes a cursor with exactly `arity` string values whose last value is the row id (a UUID, the
 * keyset tie-breaker); anything else is `400 VALIDATION_FAILED`, never a database error.
 */
export function decodeCursor(cursor: string, arity: number): string[] {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidInputError('cursor', 'The cursor is invalid.');
  }
  if (
    !Array.isArray(value) ||
    value.length !== arity ||
    !value.every((item): item is string => typeof item === 'string' && item.length <= 500) ||
    !UUID.test(value.at(-1) ?? '')
  ) {
    throw new InvalidInputError('cursor', 'The cursor is invalid.');
  }
  return value;
}

/** Clamps a requested page size to 1..MAX_PAGE_SIZE. */
export function pageSize(requested: number | undefined): number {
  if (requested === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.trunc(requested), 1), MAX_PAGE_SIZE);
}

/** Splits a `take: size + 1` result into a page and the cursor of its last row. */
export function toPage<T>(rows: readonly T[], size: number, cursorOf: (row: T) => readonly string[]): Page<T> {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > size && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}
