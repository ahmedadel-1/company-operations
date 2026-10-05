/** Keys whose values never enter audit metadata (SECURITY §7). */
const SENSITIVE_KEY = /(secret|token|password|authorization|cookie|private_?key)/i;

const MAX_DEPTH = 6;
const MAX_STRING = 2_000;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function redactValue(value: unknown, depth: number): JsonValue | undefined {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (depth >= MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1) ?? null);
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        continue;
      }
      const redacted = redactValue(item, depth + 1);
      if (redacted !== undefined) {
        result[key] = redacted;
      }
    }
    return result;
  }
  return undefined;
}

/** Drops sensitive keys at any depth, truncates long strings and nesting, and returns JSON-safe data. */
export function redactAuditMetadata(metadata: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  const redacted = redactValue(metadata, 0);
  return redacted !== null && typeof redacted === 'object' && !Array.isArray(redacted) ? redacted : {};
}
