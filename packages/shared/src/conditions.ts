/**
 * Declarative form conditions (ADR-0021): one `all`/`any` group of typed rules over form values.
 * Pure and dependency-free so the server (route planning, form validation) and the browser (live
 * field visibility) evaluate exactly the same semantics. The schema lives in @company-ops/validation.
 */
export type ConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'isSet' | 'isNotSet';

export interface ConditionRuleInput {
  readonly field: string;
  readonly op: ConditionOperator;
  readonly value?: string | number | boolean | readonly string[] | undefined;
}

export interface ConditionInput {
  readonly match: 'all' | 'any';
  readonly rules: readonly ConditionRuleInput[];
}

/** A form value after normalization (hidden and empty values are absent). */
export type FieldValue =
  string | number | boolean | readonly string[] | { readonly start: string; readonly end: string };
export type NormalizedData = Readonly<Record<string, FieldValue>>;

const isMissing = (value: FieldValue | undefined): value is undefined =>
  value === undefined ||
  (typeof value === 'string' && value.length === 0) ||
  (Array.isArray(value) && value.length === 0);

const scalar = (value: FieldValue): string | number | boolean | null =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;

function compare(left: string | number | boolean | null, right: unknown): number | null {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  // ISO dates and HH:MM times order lexically.
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  return null;
}

function contains(value: FieldValue, list: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((item: string) => list.includes(item));
  return typeof value === 'string' && list.includes(value);
}

/**
 * Evaluates one rule. A missing value makes every comparison false except `isNotSet`, `neq` and
 * `notIn`. Values of mismatched types never compare equal.
 */
export function evaluateRule(rule: ConditionRuleInput, data: NormalizedData): boolean {
  const value = data[rule.field];
  const expected = rule.value;
  if (rule.op === 'isSet') return !isMissing(value);
  if (rule.op === 'isNotSet') return isMissing(value);
  if (isMissing(value)) return rule.op === 'neq' || rule.op === 'notIn';
  switch (rule.op) {
    case 'eq':
      return scalar(value) === expected;
    case 'neq':
      return scalar(value) !== expected;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const order = compare(scalar(value), expected);
      if (order === null) return false;
      if (rule.op === 'gt') return order > 0;
      if (rule.op === 'gte') return order >= 0;
      if (rule.op === 'lt') return order < 0;
      return order <= 0;
    }
    case 'in':
      return Array.isArray(expected) && contains(value, expected);
    case 'notIn':
      return !Array.isArray(expected) || !contains(value, expected);
  }
}

/** True when the condition holds; an absent condition always holds. */
export function evaluateCondition(condition: ConditionInput | null | undefined, data: NormalizedData): boolean {
  if (condition === null || condition === undefined) return true;
  return condition.match === 'all'
    ? condition.rules.every((rule) => evaluateRule(rule, data))
    : condition.rules.some((rule) => evaluateRule(rule, data));
}
