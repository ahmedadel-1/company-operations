'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import type { paths } from '@company-ops/api-client';
import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { api, ApiError, request } from '../lib/api';
import { useRoles } from '../lib/queries';
import {
  APPROVER_TYPES,
  CONDITION_OPERATORS,
  FORM_FIELD_TYPES,
  REQUEST_LIMITS,
  requestKeys,
  useLocalized,
} from '../lib/requests';
import type {
  Condition,
  ConditionOperator,
  ConditionRule,
  FormField,
  FormFieldType,
  LocalizedText,
  WorkflowVersion,
} from '../lib/requests';
import { EmployeePicker } from './employee-picker';
import { FormError, StatusMessage } from './form';

export type WorkflowContent =
  paths['/api/v1/request-admin/types/{id}/versions/{versionId}']['put']['requestBody']['content']['application/json'];
type StepInput = WorkflowContent['steps'][number];
type Content = Omit<WorkflowContent, 'revision'>;
type Option = Extract<FormField, { type: 'select' }>['options'][number];
type RuleValueInput = Exclude<ConditionRule['value'], undefined>;

const EFFECT_MODES = ['LEAVE', 'REMOTE', 'BUSINESS_MISSION', 'SHORT_LEAVE'] as const;
const ATTACHMENT_REQUIREMENTS = ['NONE', 'OPTIONAL', 'REQUIRED'] as const;

/** The stored version as builder input. */
export function toContent(version: WorkflowVersion): Content {
  return {
    form: version.form,
    steps: version.steps.map((step) => ({
      kind: step.kind,
      name: step.name,
      ...(step.kind === 'APPROVAL' ? { mode: step.mode } : {}),
      ...(step.approver === null
        ? {}
        : {
            approver: {
              type: step.approver.type,
              ...(step.approver.member === null ? {} : { memberId: step.approver.member.memberId }),
              ...(step.approver.role === null ? {} : { roleId: step.approver.role.id }),
              ...(step.approver.projectField === null ? {} : { projectField: step.approver.projectField }),
            },
          }),
      condition: step.condition,
      slaHours: step.slaHours,
    })),
    attachments: version.attachments,
    effects: version.effects,
    notifications: version.notifications,
  };
}

function nextKey(fields: readonly FormField[]): string {
  let index = fields.length + 1;
  while (fields.some((field) => field.key === `field${String(index)}`)) index += 1;
  return `field${String(index)}`;
}

/** A field of `type` carrying over the common properties of `field`. */
function withType(field: FormField, type: FormFieldType): FormField {
  const label = field.label;
  const help = field.help === undefined ? {} : { help: field.help };
  const visibleWhen = field.visibleWhen === undefined ? {} : { visibleWhen: field.visibleWhen };
  if (type === 'info') return { key: field.key, type, label, ...help, ...visibleWhen };
  const required = field.type !== 'info' && field.required === true ? { required: true } : {};
  const base = { key: field.key, label, ...help, ...visibleWhen, ...required };
  switch (type) {
    case 'money':
      return { ...base, type, currency: 'EGP' };
    case 'select':
    case 'multiselect':
      return { ...base, type, options: [{ value: 'option1', label: { en: 'Option 1' } }] };
    default:
      return { ...base, type };
  }
}

/** Parses an optional number input; empty clears the property. */
function optionalNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Stable React keys for editable rows that have no identity of their own (keys and values are
 * themselves editable). A row keeps its key when `replace` swaps in its edited copy.
 */
function useRowKeys() {
  const [keys] = useState(() => new WeakMap<object, string>());
  return {
    keyOf(item: object): string {
      const existing = keys.get(item);
      if (existing !== undefined) return existing;
      const created = crypto.randomUUID();
      keys.set(item, created);
      return created;
    },
    replace<T extends object>(items: readonly T[], index: number, next: T): T[] {
      const previous = items[index];
      if (previous !== undefined) {
        const key = keys.get(previous);
        if (key !== undefined) keys.set(next, key);
      }
      return items.map((item, at) => (at === index ? next : item));
    },
  };
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/**
 * Workflow version editor (ADR-0021). Drafts are edited here; published and retired versions render
 * read-only. Every rule is re-checked by the server on save and again on publish.
 */
export function WorkflowBuilder({
  typeId,
  version,
  memberNames,
}: {
  readonly typeId: string;
  readonly version: WorkflowVersion;
  readonly memberNames: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('requestAdmin');
  const common = useTranslations('common');
  const queryClient = useQueryClient();
  const editable = version.editable;
  const [content, setContent] = useState<Content>(() => toContent(version));
  const [revision, setRevision] = useState(version.revision);
  const [dirty, setDirty] = useState(false);
  const [names, setNames] = useState(memberNames);
  const [status, setStatus] = useState<string | null>(null);
  const rows = useRowKeys();
  // The reserved attendance correction type keeps its system effect; only its approval route is configurable.
  const reservedEffect = content.effects.attendance?.mode === 'CORRECTION';

  const update = (next: Content) => {
    setContent(next);
    setDirty(true);
    setStatus(null);
  };
  const refresh = async (saved: WorkflowVersion) => {
    queryClient.setQueryData(requestKeys.version(typeId, saved.id), saved);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: requestKeys.adminType(typeId) }),
      queryClient.invalidateQueries({ queryKey: requestKeys.versions(typeId) }),
      queryClient.invalidateQueries({ queryKey: requestKeys.adminTypes }),
    ]);
  };
  const saveDraft = async (): Promise<WorkflowVersion> => {
    const saved = (
      await request(() =>
        api.PUT('/api/v1/request-admin/types/{id}/versions/{versionId}', {
          params: { path: { id: typeId, versionId: version.id } },
          body: { ...content, revision },
        }),
      )
    ).data;
    setRevision(saved.revision);
    setDirty(false);
    return saved;
  };
  const save = useMutation({
    mutationFn: saveDraft,
    onSuccess: async (saved) => {
      await refresh(saved);
      setStatus(t('builder.saved'));
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      const current = dirty ? (await saveDraft()).revision : revision;
      return (
        await request(() =>
          api.POST('/api/v1/request-admin/types/{id}/versions/{versionId}/publish', {
            params: { path: { id: typeId, versionId: version.id } },
            body: { revision: current },
          }),
        )
      ).data;
    },
    onSuccess: async (published) => {
      await refresh(published);
      setStatus(t('builder.published', { number: published.number }));
    },
  });
  const error = publish.error ?? save.error;
  const issues = error instanceof ApiError ? error.fieldErrors : [];
  const busy = save.isPending || publish.isPending;
  const valueFields = content.form.fields.filter((field) => field.type !== 'info');

  return (
    <div className="flex flex-col gap-4" data-testid="workflow-builder" data-editable={editable}>
      {editable ? (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background p-3">
          <Button
            data-testid="save-draft"
            disabled={busy}
            onClick={() => {
              save.mutate();
            }}
          >
            {save.isPending ? common('saving') : t('builder.save')}
          </Button>
          <Button
            variant="outline"
            data-testid="publish-version"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('builder.confirmPublish'))) publish.mutate();
            }}
          >
            {publish.isPending ? common('saving') : t('builder.publish')}
          </Button>
          {dirty ? <span className="text-sm text-muted-foreground">{t('builder.unsaved')}</span> : null}
        </div>
      ) : (
        <p role="status" className="rounded-md border p-3 text-sm" data-testid="version-readonly">
          {t('builder.readOnly')}
        </p>
      )}
      {status === null ? null : <StatusMessage>{status}</StatusMessage>}
      <FormError error={error} />
      {issues.length === 0 ? null : (
        <ul
          className="flex list-disc flex-col gap-1 rounded-md border border-destructive/40 p-3 ps-8 text-sm"
          data-testid="workflow-issues"
        >
          {issues.map((issue) => (
            <li key={`${issue.path}-${issue.code}`}>
              <IssueText path={issue.path} code={issue.code} content={content} />
            </li>
          ))}
        </ul>
      )}

      <Section title={t('builder.formTitle')} hint={t('builder.formHint', { max: REQUEST_LIMITS.maxFields })}>
        <div className="flex flex-col gap-3">
          {content.form.fields.map((field, index) => (
            <FieldEditor
              key={rows.keyOf(field)}
              index={index}
              field={field}
              fields={content.form.fields}
              disabled={!editable}
              total={content.form.fields.length}
              onChange={(next) => {
                update({ ...content, form: { fields: rows.replace(content.form.fields, index, next) } });
              }}
              onMove={(to) => {
                update({ ...content, form: { fields: moved(content.form.fields, index, to) } });
              }}
              onRemove={() => {
                update({ ...content, form: { fields: content.form.fields.filter((_, at) => at !== index) } });
              }}
            />
          ))}
          {editable ? (
            <Button
              variant="outline"
              className="self-start"
              disabled={content.form.fields.length >= REQUEST_LIMITS.maxFields}
              onClick={() => {
                update({
                  ...content,
                  form: {
                    fields: [
                      ...content.form.fields,
                      { key: nextKey(content.form.fields), type: 'text', label: { en: t('builder.newField') } },
                    ],
                  },
                });
              }}
            >
              <PlusIcon aria-hidden="true" />
              {t('builder.addField')}
            </Button>
          ) : null}
        </div>
      </Section>

      <Section title={t('builder.stepsTitle')} hint={t('builder.stepsHint')}>
        <ol className="flex flex-col gap-3">
          {content.steps.map((step, index) => (
            <StepEditor
              key={rows.keyOf(step)}
              index={index}
              step={step}
              fields={content.form.fields}
              disabled={!editable}
              total={content.steps.length}
              memberName={step.approver?.memberId === undefined ? undefined : names[step.approver.memberId]}
              onMemberName={(id, name) => {
                setNames((current) => ({ ...current, [id]: name }));
              }}
              onChange={(next) => {
                update({ ...content, steps: rows.replace(content.steps, index, next) });
              }}
              onMove={(to) => {
                update({ ...content, steps: moved(content.steps, index, to) });
              }}
              onRemove={() => {
                update({ ...content, steps: content.steps.filter((_, at) => at !== index) });
              }}
            />
          ))}
        </ol>
        {editable ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={content.steps.length >= REQUEST_LIMITS.maxSteps}
              onClick={() => {
                update({
                  ...content,
                  steps: [
                    ...content.steps,
                    {
                      kind: 'APPROVAL',
                      name: { en: t('builder.newStep') },
                      mode: 'ANY_ONE',
                      approver: { type: 'DIRECT_MANAGER' },
                      condition: null,
                      slaHours: null,
                    },
                  ],
                });
              }}
            >
              <PlusIcon aria-hidden="true" />
              {t('builder.addApproval')}
            </Button>
            <Button
              variant="outline"
              disabled={content.steps.length >= REQUEST_LIMITS.maxSteps}
              onClick={() => {
                update({
                  ...content,
                  steps: [
                    ...content.steps,
                    { kind: 'FULFILLMENT', name: { en: t('builder.newFulfillment') }, condition: null },
                  ],
                });
              }}
            >
              <PlusIcon aria-hidden="true" />
              {t('builder.addFulfillment')}
            </Button>
          </div>
        ) : null}
      </Section>

      <Section title={t('builder.settingsTitle')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <LabeledSelect
            label={t('builder.attachments')}
            value={content.attachments.requirement}
            disabled={!editable}
            options={ATTACHMENT_REQUIREMENTS.map(
              (value) => [value, t(`builder.attachmentRequirements.${value}`)] as const,
            )}
            onChange={(value) => {
              const requirement = ATTACHMENT_REQUIREMENTS.find((item) => item === value) ?? 'NONE';
              update({
                ...content,
                attachments: {
                  requirement,
                  maxFiles: requirement === 'NONE' ? 0 : Math.max(1, content.attachments.maxFiles),
                },
              });
            }}
          />
          <LabeledInput
            label={t('builder.maxFiles')}
            type="number"
            value={String(content.attachments.maxFiles)}
            disabled={!editable || content.attachments.requirement === 'NONE'}
            onChange={(value) => {
              update({ ...content, attachments: { ...content.attachments, maxFiles: optionalNumber(value) ?? 0 } });
            }}
          />
          <LabeledSelect
            label={t('builder.effect')}
            value={content.effects.attendance?.mode ?? ''}
            disabled={!editable || reservedEffect}
            options={[
              ['', t('builder.noEffect')] as const,
              ...EFFECT_MODES.map((mode) => [mode, t(`builder.effectModes.${mode}`)] as const),
              ...(reservedEffect ? [['CORRECTION', t('builder.effectModes.CORRECTION')] as const] : []),
            ]}
            onChange={(value) => {
              const mode = EFFECT_MODES.find((item) => item === value);
              const dateField =
                content.effects.attendance?.dateField ??
                content.form.fields.find((field) => field.type === 'date' || field.type === 'date_range')?.key ??
                '';
              update({ ...content, effects: mode === undefined ? {} : { attendance: { mode, dateField } } });
            }}
          />
          {content.effects.attendance?.mode === 'SHORT_LEAVE' ? (
            <>
              {(['fromTimeField', 'toTimeField'] as const).map((slot) => (
                <LabeledSelect
                  key={slot}
                  label={t(`builder.${slot}`)}
                  value={content.effects.attendance?.[slot] ?? ''}
                  disabled={!editable}
                  options={[
                    ['', t('builder.wholeDay')] as const,
                    ...content.form.fields
                      .filter((field) => field.type === 'time')
                      .map((field) => [field.key, field.label.en] as const),
                  ]}
                  onChange={(value) => {
                    const current = content.effects.attendance;
                    if (current === undefined) {
                      return;
                    }
                    const { [slot]: _previous, ...rest } = current;
                    update({ ...content, effects: { attendance: value === '' ? rest : { ...rest, [slot]: value } } });
                  }}
                />
              ))}
            </>
          ) : null}
          {content.effects.attendance === undefined ? null : (
            <LabeledSelect
              label={t('builder.effectDateField')}
              value={content.effects.attendance.dateField}
              disabled={!editable}
              options={content.form.fields
                .filter((field) => field.type === 'date' || field.type === 'date_range')
                .map((field) => [field.key, field.label.en] as const)}
              onChange={(value) => {
                if (content.effects.attendance !== undefined) {
                  update({ ...content, effects: { attendance: { ...content.effects.attendance, dateField: value } } });
                }
              }}
            />
          )}
          <Checkbox
            label={t('builder.emailApprovers')}
            checked={content.notifications.emailApprovers}
            disabled={!editable}
            onChange={(checked) => {
              update({ ...content, notifications: { ...content.notifications, emailApprovers: checked } });
            }}
          />
          <Checkbox
            label={t('builder.emailRequester')}
            checked={content.notifications.emailRequester}
            disabled={!editable}
            onChange={(checked) => {
              update({ ...content, notifications: { ...content.notifications, emailRequester: checked } });
            }}
          />
        </div>
        {valueFields.length === 0 ? null : (
          <p className="mt-3 text-xs text-muted-foreground">{t('builder.effectHint')}</p>
        )}
      </Section>
    </div>
  );
}

function IssueText({
  path,
  code,
  content,
}: {
  readonly path: string;
  readonly code: string;
  readonly content: Content;
}) {
  const t = useTranslations('requestAdmin.issues');
  const fieldErrors = useTranslations('fieldErrors');
  const parts = path.split('.');
  let where = path;
  if (parts[0] === 'form' && parts[1] === 'fields' && parts[2] !== undefined) {
    const field = content.form.fields[Number(parts[2])];
    where = t('field', { key: field?.key ?? parts[2], detail: parts.slice(3).join('.') });
  } else if (parts[0] === 'steps' && parts[1] !== undefined) {
    where = t('step', { number: Number(parts[1]) + 1, detail: parts.slice(2).join('.') });
  } else if (parts[0] === 'steps') {
    where = t('steps');
  } else if (parts[0] === 'attachments' || parts[0] === 'effects') {
    where = t('settings', { detail: parts.join('.') });
  }
  const message = t.has(`codes.${code}` as 'codes.invalid')
    ? t(`codes.${code}` as 'codes.invalid')
    : fieldErrors.has(code as 'generic')
      ? fieldErrors(code as 'generic')
      : fieldErrors('generic');
  return (
    <>
      <span className="font-medium">{where}</span>: {message}
    </>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {hint === undefined ? null : <p className="text-sm text-muted-foreground">{hint}</p>}
        {children}
      </CardContent>
    </Card>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  disabled,
  type = 'text',
  maxLength,
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly type?: 'text' | 'number';
  readonly maxLength?: number;
  readonly placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly disabled: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-11 items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="size-4"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {label}
    </label>
  );
}

function LocalizedInputs({
  label,
  value,
  onChange,
  disabled,
}: {
  readonly label: string;
  readonly value: LocalizedText;
  readonly onChange: (value: LocalizedText) => void;
  readonly disabled: boolean;
}) {
  const t = useTranslations('requestAdmin');
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <LabeledInput
        label={`${label} (${t('english')})`}
        value={value.en}
        maxLength={200}
        disabled={disabled}
        onChange={(en) => {
          onChange({ ...value, en });
        }}
      />
      <LabeledInput
        label={`${label} (${t('arabic')})`}
        value={value.ar ?? ''}
        maxLength={200}
        disabled={disabled}
        onChange={(ar) => {
          onChange(ar.trim() === '' ? { en: value.en } : { ...value, ar });
        }}
      />
    </div>
  );
}

function RowControls({
  index,
  total,
  disabled,
  label,
  onMove,
  onRemove,
}: {
  readonly index: number;
  readonly total: number;
  readonly disabled: boolean;
  readonly label: string;
  readonly onMove: (to: number) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  if (disabled) return null;
  return (
    <span className="flex gap-1">
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('moveUp', { name: label })}
        disabled={index === 0}
        onClick={() => {
          onMove(index - 1);
        }}
      >
        <ArrowUpIcon aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('moveDown', { name: label })}
        disabled={index === total - 1}
        onClick={() => {
          onMove(index + 1);
        }}
      >
        <ArrowDownIcon aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon" aria-label={t('remove', { name: label })} onClick={onRemove}>
        <Trash2Icon aria-hidden="true" />
      </Button>
    </span>
  );
}

function FieldEditor({
  index,
  field,
  fields,
  total,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  readonly index: number;
  readonly field: FormField;
  readonly fields: readonly FormField[];
  readonly total: number;
  readonly disabled: boolean;
  readonly onChange: (field: FormField) => void;
  readonly onMove: (to: number) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  const localized = useLocalized();
  return (
    <details className="rounded-lg border" data-testid="field-editor" data-key={field.key} open={field.label.en === ''}>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{localized(field.label) || field.key}</span>
          <Badge>{t(`fieldTypes.${field.type}`)}</Badge>
          {field.type !== 'info' && field.required === true ? <Badge>{t('required')}</Badge> : null}
          {field.visibleWhen === undefined ? null : <Badge>{t('conditional')}</Badge>}
        </span>
        <RowControls
          index={index}
          total={total}
          disabled={disabled}
          label={field.key}
          onMove={onMove}
          onRemove={onRemove}
        />
      </summary>
      <div className="flex flex-col gap-3 border-t p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <LabeledInput
            label={t('fieldKey')}
            value={field.key}
            maxLength={40}
            disabled={disabled}
            onChange={(key) => {
              onChange({ ...field, key });
            }}
          />
          <LabeledSelect
            label={t('fieldType')}
            value={field.type}
            disabled={disabled}
            options={FORM_FIELD_TYPES.map((type) => [type, t(`fieldTypes.${type}`)] as const)}
            onChange={(value) => {
              const type = FORM_FIELD_TYPES.find((item) => item === value);
              if (type !== undefined && type !== field.type) onChange(withType(field, type));
            }}
          />
        </div>
        <LocalizedInputs
          label={t('fieldLabel')}
          value={field.label}
          disabled={disabled}
          onChange={(label) => {
            onChange({ ...field, label });
          }}
        />
        {field.type === 'info' ? null : (
          <Checkbox
            label={t('required')}
            checked={field.required === true}
            disabled={disabled}
            onChange={(required) => {
              onChange({ ...field, required });
            }}
          />
        )}
        <TypeSettings field={field} disabled={disabled} onChange={onChange} />
        <ConditionEditor
          title={t('visibleWhen')}
          condition={field.visibleWhen ?? null}
          fields={fields.filter((item) => item.key !== field.key)}
          disabled={disabled}
          onChange={(condition) => {
            if (condition === null) {
              const { visibleWhen: _removed, ...rest } = field;
              onChange(rest);
            } else {
              onChange({ ...field, visibleWhen: condition });
            }
          }}
        />
      </div>
    </details>
  );
}

function TypeSettings({
  field,
  disabled,
  onChange,
}: {
  readonly field: FormField;
  readonly disabled: boolean;
  readonly onChange: (field: FormField) => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  const numberProp = (value: number | undefined) => (value === undefined ? '' : String(value));
  switch (field.type) {
    case 'text':
    case 'textarea':
      return (
        <LabeledInput
          label={t('maxLength')}
          type="number"
          value={numberProp(field.maxLength)}
          disabled={disabled}
          onChange={(value) => {
            const maxLength = optionalNumber(value);
            const { maxLength: _old, ...rest } = field;
            onChange(maxLength === undefined ? rest : { ...rest, maxLength });
          }}
        />
      );
    case 'number':
    case 'money':
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          {field.type === 'money' ? (
            <LabeledInput
              label={t('currency')}
              value={field.currency}
              maxLength={3}
              disabled={disabled}
              onChange={(currency) => {
                onChange({ ...field, currency: currency.toUpperCase() });
              }}
            />
          ) : null}
          <LabeledInput
            label={t('min')}
            type="number"
            value={numberProp(field.min)}
            disabled={disabled}
            onChange={(value) => {
              const min = optionalNumber(value);
              const { min: _old, ...rest } = field;
              onChange(min === undefined ? rest : { ...rest, min });
            }}
          />
          <LabeledInput
            label={t('max')}
            type="number"
            value={numberProp(field.max)}
            disabled={disabled}
            onChange={(value) => {
              const max = optionalNumber(value);
              const { max: _old, ...rest } = field;
              onChange(max === undefined ? rest : { ...rest, max });
            }}
          />
        </div>
      );
    case 'date':
      return (
        <Checkbox
          label={t('notInPast')}
          checked={field.notInPast === true}
          disabled={disabled}
          onChange={(notInPast) => {
            onChange({ ...field, notInPast });
          }}
        />
      );
    case 'date_range':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          <Checkbox
            label={t('notInPast')}
            checked={field.notInPast === true}
            disabled={disabled}
            onChange={(notInPast) => {
              onChange({ ...field, notInPast });
            }}
          />
          <LabeledInput
            label={t('maxDays')}
            type="number"
            value={numberProp(field.maxDays)}
            disabled={disabled}
            onChange={(value) => {
              const maxDays = optionalNumber(value);
              const { maxDays: _old, ...rest } = field;
              onChange(maxDays === undefined ? rest : { ...rest, maxDays });
            }}
          />
        </div>
      );
    case 'select':
    case 'multiselect':
      return (
        <OptionsEditor
          options={field.options}
          disabled={disabled}
          onChange={(options) => {
            onChange({ ...field, options });
          }}
        />
      );
    default:
      return null;
  }
}

function OptionsEditor({
  options,
  disabled,
  onChange,
}: {
  readonly options: readonly Option[];
  readonly disabled: boolean;
  readonly onChange: (options: Option[]) => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  const rows = useRowKeys();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">{t('options')}</legend>
      {options.map((option, index) => (
        <div
          key={rows.keyOf(option)}
          className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
        >
          <LabeledInput
            label={t('optionValue')}
            value={option.value}
            maxLength={50}
            disabled={disabled}
            onChange={(value) => {
              onChange(rows.replace(options, index, { ...option, value }));
            }}
          />
          <LabeledInput
            label={t('optionLabelEn')}
            value={option.label.en}
            maxLength={200}
            disabled={disabled}
            onChange={(en) => {
              onChange(rows.replace(options, index, { ...option, label: { ...option.label, en } }));
            }}
          />
          <LabeledInput
            label={t('optionLabelAr')}
            value={option.label.ar ?? ''}
            maxLength={200}
            disabled={disabled}
            onChange={(ar) => {
              onChange(
                rows.replace(options, index, {
                  ...option,
                  label: ar.trim() === '' ? { en: option.label.en } : { ...option.label, ar },
                }),
              );
            }}
          />
          {disabled ? null : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('remove', { name: option.value })}
              disabled={options.length <= 1}
              onClick={() => {
                onChange(options.filter((_, at) => at !== index));
              }}
            >
              <Trash2Icon aria-hidden="true" />
            </Button>
          )}
        </div>
      ))}
      {disabled ? null : (
        <Button
          variant="outline"
          className="self-start"
          disabled={options.length >= REQUEST_LIMITS.maxOptions}
          onClick={() => {
            onChange([
              ...options,
              { value: `option${String(options.length + 1)}`, label: { en: `Option ${String(options.length + 1)}` } },
            ]);
          }}
        >
          <PlusIcon aria-hidden="true" />
          {t('addOption')}
        </Button>
      )}
    </fieldset>
  );
}

/** Declarative condition editor: one all/any group of typed rules over other fields (no expressions). */
function ConditionEditor({
  title,
  condition,
  fields,
  disabled,
  onChange,
}: {
  readonly title: string;
  readonly condition: Condition | null;
  readonly fields: readonly FormField[];
  readonly disabled: boolean;
  readonly onChange: (condition: Condition | null) => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  const rows = useRowKeys();
  const candidates = fields.filter((field) => field.type !== 'info');
  const firstField = candidates[0];
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{title}</legend>
      <Checkbox
        label={t('conditionEnabled')}
        checked={condition !== null}
        disabled={disabled || (condition === null && firstField === undefined)}
        onChange={(checked) => {
          onChange(
            checked && firstField !== undefined
              ? { match: 'all', rules: [{ field: firstField.key, op: 'isSet' }] }
              : null,
          );
        }}
      />
      {condition === null ? null : (
        <>
          <LabeledSelect
            label={t('conditionMatch')}
            value={condition.match}
            disabled={disabled}
            options={[
              ['all', t('matchAll')],
              ['any', t('matchAny')],
            ]}
            onChange={(value) => {
              onChange({ ...condition, match: value === 'any' ? 'any' : 'all' });
            }}
          />
          {condition.rules.map((rule, index) => (
            <RuleEditor
              key={rows.keyOf(rule)}
              rule={rule}
              fields={candidates}
              disabled={disabled}
              canRemove={condition.rules.length > 1}
              onChange={(next) => {
                onChange({ ...condition, rules: rows.replace(condition.rules, index, next) });
              }}
              onRemove={() => {
                onChange({ ...condition, rules: condition.rules.filter((_, at) => at !== index) });
              }}
            />
          ))}
          {disabled || firstField === undefined ? null : (
            <Button
              variant="outline"
              className="self-start"
              disabled={condition.rules.length >= REQUEST_LIMITS.maxConditionRules}
              onClick={() => {
                onChange({ ...condition, rules: [...condition.rules, { field: firstField.key, op: 'isSet' }] });
              }}
            >
              <PlusIcon aria-hidden="true" />
              {t('addRule')}
            </Button>
          )}
        </>
      )}
    </fieldset>
  );
}

function RuleEditor({
  rule,
  fields,
  disabled,
  canRemove,
  onChange,
  onRemove,
}: {
  readonly rule: ConditionRule;
  readonly fields: readonly FormField[];
  readonly disabled: boolean;
  readonly canRemove: boolean;
  readonly onChange: (rule: ConditionRule) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  const localized = useLocalized();
  const field = fields.find((item) => item.key === rule.field);
  const withoutValue = rule.op === 'isSet' || rule.op === 'isNotSet';
  const setOp = (op: ConditionOperator) => {
    const { value: _old, ...rest } = rule;
    onChange(op === 'isSet' || op === 'isNotSet' ? { ...rest, op } : { ...rest, op, value: defaultValue(field, op) });
  };
  return (
    <div
      className="grid gap-2 rounded-md bg-muted/40 p-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end"
      data-testid="condition-rule"
    >
      <LabeledSelect
        label={t('ruleField')}
        value={rule.field}
        disabled={disabled}
        options={fields.map((item) => [item.key, localized(item.label) || item.key] as const)}
        onChange={(key) => {
          onChange({ field: key, op: 'isSet' });
        }}
      />
      <LabeledSelect
        label={t('ruleOperator')}
        value={rule.op}
        disabled={disabled}
        options={CONDITION_OPERATORS.map((op) => [op, t(`operators.${op}`)] as const)}
        onChange={(value) => {
          const op = CONDITION_OPERATORS.find((item) => item === value);
          if (op !== undefined) setOp(op);
        }}
      />
      {withoutValue ? (
        <span />
      ) : (
        <RuleValue
          field={field}
          op={rule.op}
          value={rule.value}
          disabled={disabled}
          onChange={(value) => {
            onChange({ ...rule, value });
          }}
        />
      )}
      {disabled || !canRemove ? null : (
        <Button variant="ghost" size="icon" aria-label={t('removeRule')} onClick={onRemove}>
          <Trash2Icon aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}

function defaultValue(field: FormField | undefined, op: ConditionOperator): RuleValueInput {
  if (op === 'in' || op === 'notIn') {
    return field !== undefined && (field.type === 'select' || field.type === 'multiselect')
      ? [field.options[0]?.value ?? '']
      : [''];
  }
  if (field === undefined) return '';
  switch (field.type) {
    case 'number':
    case 'money':
      return 0;
    case 'boolean':
      return true;
    case 'select':
      return field.options[0]?.value ?? '';
    default:
      return '';
  }
}

function RuleValue({
  field,
  op,
  value,
  disabled,
  onChange,
}: {
  readonly field: FormField | undefined;
  readonly op: ConditionOperator;
  readonly value: ConditionRule['value'];
  readonly disabled: boolean;
  readonly onChange: (value: RuleValueInput) => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  const localized = useLocalized();
  const label = t('ruleValue');
  const list = op === 'in' || op === 'notIn';
  if (field !== undefined && (field.type === 'select' || field.type === 'multiselect')) {
    if (list) {
      const selected = Array.isArray(value) ? value : [];
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">{label}</legend>
          {field.options.map((option) => (
            <Checkbox
              key={option.value}
              label={localized(option.label)}
              checked={selected.includes(option.value)}
              disabled={disabled}
              onChange={(checked) => {
                const next = checked ? [...selected, option.value] : selected.filter((item) => item !== option.value);
                onChange(next.length === 0 ? [option.value] : next);
              }}
            />
          ))}
        </fieldset>
      );
    }
    return (
      <LabeledSelect
        label={label}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        options={field.options.map((option) => [option.value, localized(option.label)] as const)}
        onChange={onChange}
      />
    );
  }
  if (field?.type === 'boolean') {
    return (
      <LabeledSelect
        label={label}
        value={value === false ? 'false' : 'true'}
        disabled={disabled}
        options={[
          ['true', t('true')],
          ['false', t('false')],
        ]}
        onChange={(next) => {
          onChange(next === 'true');
        }}
      />
    );
  }
  if (list) {
    return (
      <LabeledInput
        label={t('ruleValueList')}
        value={Array.isArray(value) ? value.join(', ') : ''}
        disabled={disabled}
        onChange={(next) => {
          const items = next.split(',').map((item) => item.trim());
          onChange(items.length === 0 ? [''] : items);
        }}
      />
    );
  }
  const numeric = field?.type === 'number' || field?.type === 'money';
  return (
    <LabeledInput
      label={label}
      type={numeric ? 'number' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? String(value) : ''}
      {...(field?.type === 'date'
        ? { placeholder: 'YYYY-MM-DD' }
        : field?.type === 'time'
          ? { placeholder: 'HH:MM' }
          : {})}
      disabled={disabled}
      onChange={(next) => {
        onChange(numeric ? (optionalNumber(next) ?? 0) : next);
      }}
    />
  );
}

function StepEditor({
  index,
  step,
  fields,
  total,
  disabled,
  memberName,
  onMemberName,
  onChange,
  onMove,
  onRemove,
}: {
  readonly index: number;
  readonly step: StepInput;
  readonly fields: readonly FormField[];
  readonly total: number;
  readonly disabled: boolean;
  readonly memberName: string | undefined;
  readonly onMemberName: (id: string, name: string) => void;
  readonly onChange: (step: StepInput) => void;
  readonly onMove: (to: number) => void;
  readonly onRemove: () => void;
}) {
  const t = useTranslations('requestAdmin.builder');
  const localized = useLocalized();
  const roles = useRoles(!disabled || step.approver?.type === 'ROLE');
  const approval = step.kind === 'APPROVAL';
  const approver = step.approver ?? { type: 'DIRECT_MANAGER' as const };
  const projectFields = fields.filter((field) => field.type === 'project');
  const setApproverType = (type: (typeof APPROVER_TYPES)[number]) => {
    onChange({
      ...step,
      approver:
        type === 'ROLE'
          ? { type, roleId: roles.data?.[0]?.id ?? '' }
          : type === 'MEMBER'
            ? { type, memberId: '' }
            : type === 'PROJECT_MANAGER' || type === 'TECHNICAL_MANAGER'
              ? { type, projectField: projectFields[0]?.key ?? '' }
              : { type },
    });
  };
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3" data-testid="step-editor" data-kind={step.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 font-medium">
          {t('stepNumber', { number: index + 1 })} · {localized(step.name)}
          <Badge>{approval ? t('approvalStep') : t('fulfillmentStep')}</Badge>
          {step.condition === null || step.condition === undefined ? null : <Badge>{t('conditional')}</Badge>}
        </span>
        <RowControls
          index={index}
          total={total}
          disabled={disabled}
          label={step.name.en}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>
      <LocalizedInputs
        label={t('stepName')}
        value={step.name}
        disabled={disabled}
        onChange={(name) => {
          onChange({ ...step, name });
        }}
      />
      {approval ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <LabeledSelect
              label={t('approverType')}
              value={approver.type}
              disabled={disabled}
              options={APPROVER_TYPES.map((type) => [type, t(`approverTypes.${type}`)] as const)}
              onChange={(value) => {
                const type = APPROVER_TYPES.find((item) => item === value);
                if (type !== undefined) setApproverType(type);
              }}
            />
            <LabeledSelect
              label={t('mode')}
              value={step.mode ?? 'ANY_ONE'}
              disabled={disabled}
              options={[
                ['ANY_ONE', t('modes.ANY_ONE')],
                ['ALL', t('modes.ALL')],
              ]}
              onChange={(value) => {
                onChange({ ...step, mode: value === 'ALL' ? 'ALL' : 'ANY_ONE' });
              }}
            />
            <LabeledInput
              label={t('slaHours')}
              type="number"
              value={step.slaHours === null || step.slaHours === undefined ? '' : String(step.slaHours)}
              disabled={disabled}
              onChange={(value) => {
                onChange({ ...step, slaHours: optionalNumber(value) ?? null });
              }}
            />
          </div>
          {approver.type === 'ROLE' ? (
            <LabeledSelect
              label={t('approverRole')}
              value={approver.roleId ?? ''}
              disabled={disabled}
              options={(roles.data ?? []).map((role) => [role.id, role.name] as const)}
              onChange={(roleId) => {
                onChange({ ...step, approver: { type: 'ROLE', roleId } });
              }}
            />
          ) : null}
          {approver.type === 'MEMBER' ? (
            disabled ? (
              <p className="text-sm">
                {t('approverMember')}: {memberName ?? t('unknownMember')}
              </p>
            ) : (
              <EmployeePicker
                label={t('approverMember')}
                identity="member"
                value={
                  approver.memberId === undefined || approver.memberId === ''
                    ? null
                    : { id: approver.memberId, fullName: memberName ?? t('unknownMember') }
                }
                onChange={(picked) => {
                  if (picked !== null) onMemberName(picked.id, picked.fullName);
                  onChange({ ...step, approver: { type: 'MEMBER', memberId: picked?.id ?? '' } });
                }}
              />
            )
          ) : null}
          {approver.type === 'PROJECT_MANAGER' || approver.type === 'TECHNICAL_MANAGER' ? (
            <LabeledSelect
              label={t('projectField')}
              value={approver.projectField ?? ''}
              disabled={disabled}
              options={[
                ['', t('chooseProjectField')] as const,
                ...projectFields.map((field) => [field.key, localized(field.label) || field.key] as const),
              ]}
              onChange={(projectField) => {
                onChange({ ...step, approver: { type: approver.type, projectField } });
              }}
            />
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('fulfillmentHint')}</p>
      )}
      <ConditionEditor
        title={t('stepCondition')}
        condition={step.condition ?? null}
        fields={fields}
        disabled={disabled}
        onChange={(condition) => {
          onChange({ ...step, condition });
        }}
      />
    </li>
  );
}
