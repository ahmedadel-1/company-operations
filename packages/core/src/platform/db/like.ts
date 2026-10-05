/**
 * Escapes LIKE wildcards so user text is matched literally. Prisma's `contains` / `startsWith` pass the
 * value into `LIKE`/`ILIKE` unescaped; backslash is PostgreSQL's default escape character.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
