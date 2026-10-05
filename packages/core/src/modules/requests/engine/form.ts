import { FORM_LIMITS } from '@company-ops/validation';
import type { FormField, FormSchema, RequestFormData } from '@company-ops/validation';

import { daysBetween } from '../../projects/business-date.js';
import { evaluateCondition } from './conditions.js';
import type { FieldValue, NormalizedData } from './conditions.js';

export type FormIssueCode =
  | 'unknown'
  | 'hidden'
  | 'required'
  | 'invalid'
  | 'too_short'
  | 'too_long'
  | 'too_small'
  | 'too_large'
  | 'in_past'
  | 'range'
  | 'not_allowed';

export interface FormIssue {
  /** `formData.<key>`. */
  readonly path: string;
  readonly code: FormIssueCode;
}

export interface FormValidationResult {
  readonly data: NormalizedData;
  readonly issues: readonly FormIssue[];
  /** Values of `member` fields, to be resolved in the organization. */
  readonly memberIds: readonly string[];
  /** Values of `project` fields in form order, to be resolved against the requester's visible projects. */
  readonly projectIds: readonly string[];
}

export interface FormValidationOptions {
  /** `draft`: types and limits only. `submit`: also required fields and minimum counts. */
  readonly mode: 'draft' | 'submit';
  /** Today in the organization's time zone (`YYYY-MM-DD`), for `notInPast`. */
  readonly today: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const hasAtMostTwoDecimals = (value: number): boolean => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

type Parsed = { ok: true; value: FieldValue | undefined } | { ok: false; code: FormIssueCode };
const fail = (code: FormIssueCode): Parsed => ({ ok: false, code });
const ok = (value: FieldValue | undefined): Parsed => ({ ok: true, value });

function checkRange(value: number, min: number | undefined, max: number | undefined): Parsed {
  if (min !== undefined && value < min) return fail('too_small');
  if (max !== undefined && value > max) return fail('too_large');
  return ok(value);
}

/** Parses one raw value against its field; `undefined` = empty. Visibility and required are checked by the caller. */
function parseValue(field: FormField, raw: unknown, options: FormValidationOptions): Parsed {
  if (raw === null || raw === undefined) return ok(undefined);
  switch (field.type) {
    case 'info':
      return fail('not_allowed');
    case 'text':
    case 'textarea': {
      if (typeof raw !== 'string') return fail('invalid');
      const value = raw.trim();
      if (value.length === 0) return ok(undefined);
      const max =
        field.maxLength ?? (field.type === 'text' ? FORM_LIMITS.maxTextLength : FORM_LIMITS.maxTextareaLength);
      if (value.length > max) return fail('too_long');
      if (field.minLength !== undefined && value.length < field.minLength) return fail('too_short');
      return ok(value);
    }
    case 'number':
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return fail('invalid');
      if (field.integer === true && !Number.isInteger(raw)) return fail('invalid');
      return checkRange(raw, field.min, field.max);
    case 'money':
      if (typeof raw !== 'number' || !Number.isFinite(raw) || !hasAtMostTwoDecimals(raw)) return fail('invalid');
      return checkRange(raw, field.min, field.max);
    case 'date':
      if (!isIsoDate(raw)) return fail('invalid');
      if (field.notInPast === true && raw < options.today) return fail('in_past');
      return ok(raw);
    case 'date_range': {
      if (typeof raw !== 'object' || Array.isArray(raw)) return fail('invalid');
      const record = raw as Record<string, unknown>;
      const { start, end } = record;
      if (Object.keys(record).length !== 2 || !isIsoDate(start) || !isIsoDate(end)) return fail('invalid');
      if (end < start) return fail('range');
      if (field.notInPast === true && start < options.today) return fail('in_past');
      if (field.maxDays !== undefined && daysBetween(start, end) + 1 > field.maxDays) return fail('too_large');
      return ok({ start, end });
    }
    case 'time':
      return typeof raw === 'string' && TIME.test(raw) ? ok(raw) : fail('invalid');
    case 'boolean':
      return typeof raw === 'boolean' ? ok(raw) : fail('invalid');
    case 'select':
      if (typeof raw !== 'string') return fail('invalid');
      return field.options.some((option) => option.value === raw) ? ok(raw) : fail('not_allowed');
    case 'multiselect': {
      if (!Array.isArray(raw) || !raw.every((item): item is string => typeof item === 'string')) return fail('invalid');
      if (new Set(raw).size !== raw.length) return fail('invalid');
      const allowed = new Set(field.options.map((option) => option.value));
      if (!raw.every((item) => allowed.has(item))) return fail('not_allowed');
      if (raw.length === 0) return ok(undefined);
      if (field.maxItems !== undefined && raw.length > field.maxItems) return fail('too_large');
      if (options.mode === 'submit' && field.minItems !== undefined && raw.length < field.minItems)
        return fail('too_small');
      return ok([...raw]);
    }
    case 'member':
    case 'project':
      return typeof raw === 'string' && UUID.test(raw) ? ok(raw.toLowerCase()) : fail('invalid');
  }
}

/** Fields visible for `data` (conditions are evaluated over the parsed values). */
export function visibleFieldKeys(schema: FormSchema, data: NormalizedData): ReadonlySet<string> {
  return new Set(schema.fields.filter((field) => evaluateCondition(field.visibleWhen, data)).map((field) => field.key));
}

/**
 * Validates requester input against a form schema (pure). Unknown keys and values of hidden fields are
 * rejected rather than dropped, so a client can never smuggle data past conditional visibility.
 */
export function validateFormData(
  schema: FormSchema,
  input: RequestFormData,
  options: FormValidationOptions,
): FormValidationResult {
  const issues: FormIssue[] = [];
  const byKey = new Map(schema.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) issues.push({ path: `formData.${key}`, code: 'unknown' });
  }

  const parsed: Record<string, FieldValue> = {};
  const invalid = new Set<string>();
  for (const field of schema.fields) {
    const result = parseValue(field, input[field.key], options);
    if (!result.ok) {
      issues.push({ path: `formData.${field.key}`, code: result.code });
      invalid.add(field.key);
    } else if (result.value !== undefined) {
      parsed[field.key] = result.value;
    }
  }

  const visible = visibleFieldKeys(schema, parsed);
  const data: Record<string, FieldValue> = {};
  const memberIds: string[] = [];
  const projectIds: string[] = [];
  for (const field of schema.fields) {
    const value = parsed[field.key];
    if (!visible.has(field.key)) {
      if (value !== undefined) {
        issues.push({ path: `formData.${field.key}`, code: 'hidden' });
      }
      continue;
    }
    if (value !== undefined) data[field.key] = value;
    if (value === undefined) {
      if (options.mode === 'submit' && field.type !== 'info' && field.required === true && !invalid.has(field.key)) {
        issues.push({ path: `formData.${field.key}`, code: 'required' });
      }
      continue;
    }
    if (options.mode === 'submit' && field.type === 'boolean' && field.required === true && value !== true) {
      issues.push({ path: `formData.${field.key}`, code: 'required' });
    }
    if (field.type === 'member' && typeof value === 'string') memberIds.push(value);
    if (field.type === 'project' && typeof value === 'string') projectIds.push(value);
  }

  if (JSON.stringify(data).length > FORM_LIMITS.maxDataBytes) {
    issues.push({ path: 'formData', code: 'too_large' });
  }
  return { data, issues, memberIds: [...new Set(memberIds)], projectIds };
}
