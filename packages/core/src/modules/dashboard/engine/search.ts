import { createHash } from 'node:crypto';

import { InvalidInputError } from '../../../platform/errors.js';

/** Global search bounds (ADR-0023). */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 100;
export const SEARCH_DEFAULT_LIMIT = 5;
/** "More" pagination within one type stops here. */
export const SEARCH_MAX_OFFSET = 50;

// Control and format characters (including bidi overrides) never reach the database.
const CONTROL = /[\p{Cc}\p{Cf}]/gu;

/**
 * NFKC (folds full-width and compatibility forms), control/format characters removed, whitespace
 * collapsed, trimmed. Throws `400` when the result is shorter or longer than the bounds.
 */
export function normalizeSearchQuery(raw: string): string {
  const value = raw.normalize('NFKC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  // UTF-16 length: Arabic and Latin are one unit per letter; astral symbols count double (stricter bound).
  if (value.length < SEARCH_MIN_LENGTH || value.length > SEARCH_MAX_LENGTH) {
    throw new InvalidInputError(
      'q',
      `The search text must be ${String(SEARCH_MIN_LENGTH)}–${String(SEARCH_MAX_LENGTH)} characters.`,
    );
  }
  return value;
}

/** Match quality, best first: exact key, key/text prefix, word start, substring. */
export type MatchTier = 0 | 1 | 2 | 3 | 4;

export function matchTier(query: string, key: string | null, texts: readonly string[]): MatchTier {
  const q = query.toLowerCase();
  const k = key?.toLowerCase() ?? null;
  if (k !== null && k === q) return 0;
  const lowered = texts.map((text) => text.toLowerCase());
  if ((k?.startsWith(q) ?? false) || lowered.some((text) => text.startsWith(q))) return 1;
  if (lowered.some((text) => text.split(/[\s\-_/.,:()]+/).some((word) => word.startsWith(q)))) return 2;
  if ((k?.includes(q) ?? false) || lowered.some((text) => text.includes(q))) return 3;
  return 4;
}

export interface Rankable {
  readonly id: string;
  readonly key: string | null;
  readonly title: string;
  readonly texts: readonly string[];
}

/** Deterministic order: match tier, then title, then id. */
export function rankResults<T extends Rankable>(query: string, items: readonly T[]): T[] {
  const tiers = new Map(items.map((item) => [item.id, matchTier(query, item.key, [item.title, ...item.texts])]));
  return [...items].sort((a, b) => {
    const byTier = (tiers.get(a.id) ?? 4) - (tiers.get(b.id) ?? 4);
    if (byTier !== 0) return byTier;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

const queryDigest = (query: string): string => createHash('sha256').update(query).digest('hex').slice(0, 16);

/** Offset cursor bound to the normalized query, so a cursor cannot be replayed against other text. */
export function encodeSearchCursor(offset: number, query: string): string {
  return Buffer.from(JSON.stringify({ o: offset, q: queryDigest(query) }), 'utf8').toString('base64url');
}

export function decodeSearchCursor(cursor: string, query: string): number {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidInputError('cursor', 'The cursor is invalid.');
  }
  if (typeof value !== 'object' || value === null) {
    throw new InvalidInputError('cursor', 'The cursor is invalid.');
  }
  const { o, q } = value as Record<string, unknown>;
  if (
    typeof o !== 'number' ||
    !Number.isInteger(o) ||
    o < 1 ||
    o >= SEARCH_MAX_OFFSET ||
    typeof q !== 'string' ||
    q !== queryDigest(query)
  ) {
    throw new InvalidInputError('cursor', 'The cursor is invalid.');
  }
  return o;
}

/** `SUP-12` / `12` → 12. */
export function ticketNumberOf(query: string): number | null {
  const match = /^(?:SUP-)?(\d{1,9})$/i.exec(query);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** `REQ-7` / `7` → 7. */
export function requestNumberOf(query: string): number | null {
  const match = /^(?:REQ-)?(\d{1,9})$/i.exec(query);
  return match?.[1] === undefined ? null : Number(match[1]);
}
