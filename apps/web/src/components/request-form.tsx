'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { evaluateCondition } from '@company-ops/shared';
import type { FieldValue, NormalizedData } from '@company-ops/shared';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { useProjects } from '../lib/projects';
import { REQUEST_LIMITS, useLocalized } from '../lib/requests';
import type { FormField, FormSchema, FormValue, RequestFormData } from '../lib/requests';
import { useCan } from '../lib/session';
import { EmployeePicker } from './employee-picker';
import { Field } from './form';

/** Editable form state: what the inputs hold, before conversion to submitted values. */
export type DraftValue = string | boolean | readonly string[] | { readonly start: string; readonly end: string };
export type FormDraft = Readonly<Record<string, DraftValue>>;

/** Display names of picked members (the form stores member ids only). */
export type MemberNames = Readonly<Record<string, string>>;

function isRange(value: DraftValue | undefined): value is { readonly start: string; readonly end: string } {
  return typeof value === 'object' && !Array.isArray(value);
}

function isList(value: DraftValue): value is readonly string[] {
  return Array.isArray(value);
}

/** One draft value as it would be submitted; undefined when empty. */
function toValue(field: FormField, value: DraftValue | undefined): FormValue | undefined {
  if (value === undefined || field.type === 'info') return undefined;
  switch (field.type) {
    case 'number':
    case 'money': {
      if (typeof value !== 'string' || value.trim() === '') return undefined;
      const parsed = Number(value);
      // An unparsable number is sent as typed so the server reports it as invalid.
      return Number.isFinite(parsed) ? parsed : value;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'multiselect':
      return isList(value) && value.length > 0 ? [...value] : undefined;
    case 'date_range':
      return isRange(value) && (value.start !== '' || value.end !== '')
        ? { start: value.start, end: value.end }
        : undefined;
    default:
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  }
}

/** Values the conditions see: the same shape the server evaluates after parsing. */
function normalized(schema: FormSchema, draft: FormDraft): NormalizedData {
  const data: Record<string, FieldValue> = {};
  for (const field of schema.fields) {
    const value = toValue(field, draft[field.key]);
    if (value !== undefined) data[field.key] = value;
  }
  return data;
}

export function visibleFields(schema: FormSchema, draft: FormDraft): readonly FormField[] {
  const data = normalized(schema, draft);
  return schema.fields.filter((field) => evaluateCondition(field.visibleWhen, data));
}

/** Submitted `formData`: visible, non-empty values only (the server rejects values of hidden fields). */
export function toFormData(schema: FormSchema, draft: FormDraft): RequestFormData {
  const out: Record<string, FormValue> = {};
  for (const field of visibleFields(schema, draft)) {
    const value = toValue(field, draft[field.key]);
    if (value !== undefined) out[field.key] = value;
  }
  return out;
}

/** Editable state from stored values (draft editing). */
export function toDraft(data: RequestFormData): FormDraft {
  const out: Record<string, DraftValue> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null) continue;
    out[key] = typeof value === 'number' ? String(value) : value;
  }
  return out;
}

/**
 * Renders a configured request form (ADR-0021): only catalog field types, no markup or scripts from
 * configuration; labels are plain text. Fields hidden by their condition are not rendered and not sent.
 */
export function RequestFormFields({
  schema,
  draft,
  onChange,
  errors,
  memberNames,
  onMemberName,
  disabled,
}: {
  readonly schema: FormSchema;
  readonly draft: FormDraft;
  readonly onChange: (draft: FormDraft) => void;
  readonly errors: ReadonlyMap<string, string>;
  readonly memberNames: MemberNames;
  readonly onMemberName: (memberId: string, name: string) => void;
  readonly disabled?: boolean;
}) {
  const fields = visibleFields(schema, draft);
  const set = (key: string, value: DraftValue | undefined) => {
    const next = Object.fromEntries(Object.entries(draft).filter(([existing]) => existing !== key));
    onChange(value === undefined ? next : { ...next, [key]: value });
  };
  return (
    <div className="flex flex-col gap-4" data-testid="request-form-fields">
      {fields.map((field) => (
        <FieldInput
          key={field.key}
          field={field}
          value={draft[field.key]}
          errorCode={errors.get(field.key)}
          memberName={(() => {
            const value = draft[field.key];
            return typeof value === 'string' ? memberNames[value] : undefined;
          })()}
          onMemberName={onMemberName}
          disabled={disabled === true}
          onChange={(value) => {
            set(field.key, value);
          }}
        />
      ))}
    </div>
  );
}

function FieldInput({
  field,
  value,
  errorCode,
  memberName,
  onMemberName,
  disabled,
  onChange,
}: {
  readonly field: FormField;
  readonly value: DraftValue | undefined;
  readonly errorCode: string | undefined;
  readonly memberName: string | undefined;
  readonly onMemberName: (memberId: string, name: string) => void;
  readonly disabled: boolean;
  readonly onChange: (value: DraftValue | undefined) => void;
}) {
  const t = useTranslations('requests.form');
  const localized = useLocalized();
  const label = localized(field.label);
  const hint = field.help === undefined ? undefined : localized(field.help);
  const optional = field.type !== 'info' && field.required !== true;
  const text = typeof value === 'string' ? value : '';

  switch (field.type) {
    case 'info':
      return (
        <div className="rounded-md border bg-muted/40 p-3 text-sm" data-field={field.key}>
          <p className="font-medium">{label}</p>
          {hint === undefined ? null : <p className="text-muted-foreground">{hint}</p>}
        </div>
      );
    case 'text':
    case 'textarea':
    case 'number':
    case 'money':
    case 'date':
    case 'time':
      return (
        <Field
          label={label}
          hint={
            field.type === 'money'
              ? [hint, t('currency', { currency: field.currency })].filter((part) => part !== undefined).join(' ')
              : hint
          }
          errorCode={errorCode}
          optional={optional}
        >
          {(control) =>
            field.type === 'textarea' ? (
              <Textarea
                {...control}
                name={field.key}
                rows={4}
                disabled={disabled}
                maxLength={field.maxLength ?? REQUEST_LIMITS.maxTextareaLength}
                value={text}
                onChange={(event) => {
                  onChange(event.target.value);
                }}
              />
            ) : (
              <Input
                {...control}
                name={field.key}
                disabled={disabled}
                type={
                  field.type === 'number' || field.type === 'money'
                    ? 'number'
                    : field.type === 'date'
                      ? 'date'
                      : field.type === 'time'
                        ? 'time'
                        : 'text'
                }
                inputMode={field.type === 'money' ? 'decimal' : field.type === 'number' ? 'numeric' : undefined}
                step={
                  field.type === 'money'
                    ? '0.01'
                    : field.type === 'number' && field.integer !== true
                      ? 'any'
                      : undefined
                }
                min={field.type === 'number' || field.type === 'money' ? field.min : undefined}
                max={field.type === 'number' || field.type === 'money' ? field.max : undefined}
                maxLength={field.type === 'text' ? (field.maxLength ?? REQUEST_LIMITS.maxTextLength) : undefined}
                value={text}
                onChange={(event) => {
                  onChange(event.target.value);
                }}
              />
            )
          }
        </Field>
      );
    case 'boolean':
      return (
        <BooleanInput
          field={field}
          label={label}
          hint={hint}
          checked={value === true}
          errorCode={errorCode}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'select':
      return (
        <Field label={label} hint={hint} errorCode={errorCode} optional={optional}>
          {(control) => (
            <NativeSelect
              {...control}
              name={field.key}
              disabled={disabled}
              value={text}
              onChange={(event) => {
                onChange(event.target.value === '' ? undefined : event.target.value);
              }}
            >
              <option value="">{t('choose')}</option>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {localized(option.label)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      );
    case 'multiselect':
      return (
        <ChoiceGroup
          field={field}
          label={label}
          hint={hint}
          optional={optional}
          selected={Array.isArray(value) ? value : []}
          errorCode={errorCode}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'date_range':
      return (
        <RangeInput
          field={field}
          label={label}
          hint={hint}
          optional={optional}
          value={isRange(value) ? value : { start: '', end: '' }}
          errorCode={errorCode}
          disabled={disabled}
          onChange={onChange}
        />
      );
    case 'member':
      return (
        <div className="flex flex-col gap-1.5" data-field={field.key}>
          <EmployeePicker
            label={optional ? `${label} (${t('optional')})` : label}
            identity="member"
            allowNone={optional}
            value={typeof value === 'string' ? { id: value, fullName: memberName ?? t('selectedMember') } : null}
            onChange={(picked) => {
              if (picked === null) {
                onChange(undefined);
              } else {
                onMemberName(picked.id, picked.fullName);
                onChange(picked.id);
              }
            }}
          />
          {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
          <ErrorText code={errorCode} />
        </div>
      );
    case 'project':
      return (
        <ProjectInput
          field={field}
          label={label}
          hint={hint}
          optional={optional}
          value={text}
          errorCode={errorCode}
          disabled={disabled}
          onChange={onChange}
        />
      );
  }
}

export function ErrorText({ code, id }: { readonly code: string | undefined; readonly id?: string }) {
  const t = useTranslations('fieldErrors');
  if (code === undefined) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {t.has(code as 'generic') ? t(code as 'generic') : t('generic')}
    </p>
  );
}

function BooleanInput({
  field,
  label,
  hint,
  checked,
  errorCode,
  disabled,
  onChange,
}: {
  readonly field: FormField;
  readonly label: string;
  readonly hint: string | undefined;
  readonly checked: boolean;
  readonly errorCode: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DraftValue | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5" data-field={field.key}>
      <label htmlFor={id} className="flex min-h-11 items-center gap-2 text-sm font-medium">
        <input
          id={id}
          type="checkbox"
          name={field.key}
          className="size-4"
          disabled={disabled}
          checked={checked}
          aria-invalid={errorCode === undefined ? undefined : true}
          aria-describedby={
            [hint === undefined ? null : `${id}-hint`, errorCode === undefined ? null : `${id}-error`]
              .filter((value) => value !== null)
              .join(' ') || undefined
          }
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        {label}
      </label>
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <ErrorText code={errorCode} id={`${id}-error`} />
    </div>
  );
}

function ChoiceGroup({
  field,
  label,
  hint,
  optional,
  selected,
  errorCode,
  disabled,
  onChange,
}: {
  readonly field: Extract<FormField, { type: 'multiselect' }>;
  readonly label: string;
  readonly hint: string | undefined;
  readonly optional: boolean;
  readonly selected: readonly string[];
  readonly errorCode: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DraftValue | undefined) => void;
}) {
  const t = useTranslations('requests.form');
  const localized = useLocalized();
  return (
    <fieldset
      className="flex flex-col gap-1.5"
      data-field={field.key}
      aria-invalid={errorCode === undefined ? undefined : true}
    >
      <legend className="mb-1.5 text-sm font-medium">
        {label}
        {optional ? <span className="ms-1 font-normal text-muted-foreground">({t('optional')})</span> : null}
      </legend>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex flex-col rounded-md border">
        {field.options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-accent"
          >
            <input
              type="checkbox"
              className="size-4"
              disabled={disabled}
              checked={selected.includes(option.value)}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...selected, option.value]
                  : selected.filter((item) => item !== option.value);
                onChange(next.length === 0 ? undefined : next);
              }}
            />
            {localized(option.label)}
          </label>
        ))}
      </div>
      <ErrorText code={errorCode} />
    </fieldset>
  );
}

function RangeInput({
  field,
  label,
  hint,
  optional,
  value,
  errorCode,
  disabled,
  onChange,
}: {
  readonly field: FormField;
  readonly label: string;
  readonly hint: string | undefined;
  readonly optional: boolean;
  readonly value: { readonly start: string; readonly end: string };
  readonly errorCode: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DraftValue | undefined) => void;
}) {
  const t = useTranslations('requests.form');
  const id = useId();
  const update = (next: { start: string; end: string }) => {
    onChange(next.start === '' && next.end === '' ? undefined : next);
  };
  return (
    <fieldset
      className="flex flex-col gap-1.5"
      data-field={field.key}
      aria-invalid={errorCode === undefined ? undefined : true}
    >
      <legend className="mb-1.5 text-sm font-medium">
        {label}
        {optional ? <span className="ms-1 font-normal text-muted-foreground">({t('optional')})</span> : null}
      </legend>
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-start`}>{t('from')}</Label>
          <Input
            id={`${id}-start`}
            name={`${field.key}.start`}
            type="date"
            disabled={disabled}
            value={value.start}
            onChange={(event) => {
              update({ start: event.target.value, end: value.end === '' ? event.target.value : value.end });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-end`}>{t('to')}</Label>
          <Input
            id={`${id}-end`}
            name={`${field.key}.end`}
            type="date"
            disabled={disabled}
            min={value.start === '' ? undefined : value.start}
            value={value.end}
            onChange={(event) => {
              update({ start: value.start, end: event.target.value });
            }}
          />
        </div>
      </div>
      <ErrorText code={errorCode} />
    </fieldset>
  );
}

function ProjectInput({
  field,
  label,
  hint,
  optional,
  value,
  errorCode,
  disabled,
  onChange,
}: {
  readonly field: FormField;
  readonly label: string;
  readonly hint: string | undefined;
  readonly optional: boolean;
  readonly value: string;
  readonly errorCode: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: DraftValue | undefined) => void;
}) {
  const t = useTranslations('requests.form');
  const can = useCan();
  const readsProjects = can('project.view');
  const projects = useProjects({}, readsProjects);
  const options = (projects.data?.pages.flatMap((page) => page.data) ?? []).filter(
    (project) => project.status !== 'ARCHIVED',
  );
  return (
    <Field label={label} hint={hint} errorCode={errorCode} optional={optional}>
      {(control) => (
        <NativeSelect
          {...control}
          name={field.key}
          disabled={disabled || !readsProjects}
          value={value}
          onChange={(event) => {
            onChange(event.target.value === '' ? undefined : event.target.value);
          }}
        >
          <option value="">{t('noProject')}</option>
          {options.map((project) => (
            <option key={project.id} value={project.id}>
              {project.code} · {project.name}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}
