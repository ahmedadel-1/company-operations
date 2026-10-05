'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PencilIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import { PROJECT_ROLES, useProjects } from '../lib/projects';
import {
  supportKeys,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  useBusinessCalendars,
  useEscalationRules,
  useSlaPolicies,
  useSupportCategories,
  useSupportComponents,
} from '../lib/support';
import type { BusinessCalendar, EscalationRule, SlaPolicy, SupportCategory, SupportComponent } from '../lib/support';
import { Field, fieldErrorsOf, FormError } from './form';
import { EmptyState, ErrorState, ListSkeleton } from './states';

const PAUSABLE = ['TRIAGED', 'IN_PROGRESS', 'ESCALATED', 'WAITING_FOR_DEVELOPMENT', 'WAITING_FOR_CUSTOMER'] as const;
type Pausable = (typeof PAUSABLE)[number];
const TRIGGERS = ['RESOLUTION_ELAPSED_PERCENT', 'UNRESOLVED_AFTER_MINUTES', 'FIRST_RESPONSE_BREACHED'] as const;
const ROLE_KEYS = [
  'ORG_ADMIN',
  'GENERAL_MANAGER',
  'TECHNICAL_MANAGER',
  'DEPARTMENT_MANAGER',
  'PROJECT_MANAGER',
  'TEAM_LEAD',
  'HR_ADMIN',
  'SUPPORT_AGENT',
  'FIELD_EMPLOYEE',
  'EMPLOYEE',
] as const;
type RoleKey = (typeof ROLE_KEYS)[number];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
type Weekday = (typeof WEEKDAYS)[number];

function toggle<T>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
}

function Section({
  title,
  addLabel,
  renderForm,
  children,
}: {
  readonly title: string;
  readonly addLabel: string;
  readonly renderForm: (close: () => void) => ReactNode;
  readonly children: ReactNode;
}) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <Dialog open={open} onOpenChange={setOpen}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(true);
            }}
          >
            <PlusIcon aria-hidden="true" />
            {addLabel}
          </Button>
          <DialogContent title={addLabel} closeLabel={t('close')}>
            {open
              ? renderForm(() => {
                  setOpen(false);
                })
              : null}
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function EditButton({
  name,
  renderForm,
}: {
  readonly name: string;
  readonly renderForm: (close: () => void) => ReactNode;
}) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const label = t('support.config.edit', { name });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={label}
        onClick={() => {
          setOpen(true);
        }}
      >
        <PencilIcon aria-hidden="true" />
      </Button>
      <DialogContent title={label} closeLabel={t('common.close')}>
        {open
          ? renderForm(() => {
              setOpen(false);
            })
          : null}
      </DialogContent>
    </Dialog>
  );
}

function ActiveBadge({ active }: { readonly active: boolean }) {
  const t = useTranslations('support.config');
  return <Badge tone={active ? 'success' : 'neutral'}>{active ? t('active') : t('inactive')}</Badge>;
}

function QueryState({
  query,
  empty,
  children,
}: {
  readonly query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown> };
  readonly empty: boolean;
  readonly children: ReactNode;
}) {
  const t = useTranslations('support.config');
  if (query.isPending) {
    return <ListSkeleton rows={2} />;
  }
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  return empty ? <EmptyState message={t('empty')} /> : children;
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {label}
    </label>
  );
}

function SaveRow({ pending, onCancel }: { readonly pending: boolean; readonly onCancel: () => void }) {
  const t = useTranslations('common');
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={pending}>
        {pending ? t('saving') : t('save')}
      </Button>
      <Button type="button" variant="outline" onClick={onCancel}>
        {t('cancel')}
      </Button>
    </div>
  );
}

// ---- Categories and components ----

export function CategoriesSection() {
  const t = useTranslations('support.config');
  const categories = useSupportCategories({ includeInactive: true });
  const rows = categories.data ?? [];
  return (
    <Section
      title={t('tabs.categories')}
      addLabel={t('addCategory')}
      renderForm={(close) => <TaxonomyForm kind="category" onDone={close} />}
    >
      <QueryState query={categories} empty={rows.length === 0}>
        <ul className="flex flex-col divide-y" data-testid="support-categories">
          {rows.map((category) => (
            <li key={category.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{category.name}</span>
                {category.description === null ? null : (
                  <span className="text-sm text-muted-foreground">{category.description}</span>
                )}
              </span>
              <span className="flex items-center gap-2">
                <ActiveBadge active={category.active} />
                <EditButton
                  name={category.name}
                  renderForm={(close) => <TaxonomyForm kind="category" current={category} onDone={close} />}
                />
              </span>
            </li>
          ))}
        </ul>
      </QueryState>
    </Section>
  );
}

export function ComponentsSection() {
  const t = useTranslations('support.config');
  const components = useSupportComponents({ includeInactive: true });
  const rows = components.data ?? [];
  return (
    <Section
      title={t('tabs.components')}
      addLabel={t('addComponent')}
      renderForm={(close) => <TaxonomyForm kind="component" onDone={close} />}
    >
      <QueryState query={components} empty={rows.length === 0}>
        <ul className="flex flex-col divide-y">
          {rows.map((component) => (
            <li key={component.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{component.name}</span>
                <span className="text-sm text-muted-foreground">
                  {component.project === null ? t('global') : `${component.project.code} · ${component.project.name}`}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <ActiveBadge active={component.active} />
                <EditButton
                  name={component.name}
                  renderForm={(close) => <TaxonomyForm kind="component" current={component} onDone={close} />}
                />
              </span>
            </li>
          ))}
        </ul>
      </QueryState>
    </Section>
  );
}

function TaxonomyForm({
  kind,
  current,
  onDone,
}: {
  readonly kind: 'category' | 'component';
  readonly current?: SupportCategory | SupportComponent;
  readonly onDone: () => void;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const projects = useProjects({}, kind === 'component');
  const [form, setForm] = useState({
    name: current?.name ?? '',
    description: current?.description ?? '',
    active: current?.active ?? true,
    projectId: current !== undefined && 'project' in current ? (current.project?.id ?? '') : '',
  });
  const save = useMutation({
    mutationFn: async () => {
      const base = {
        name: form.name.trim(),
        description: form.description.trim() === '' ? null : form.description.trim(),
        active: form.active,
      };
      if (kind === 'category') {
        return current === undefined
          ? request(() => api.POST('/api/v1/support/categories', { body: base }))
          : request(() =>
              api.PATCH('/api/v1/support/categories/{id}', { params: { path: { id: current.id } }, body: base }),
            );
      }
      const body = { ...base, projectId: form.projectId === '' ? null : form.projectId };
      return current === undefined
        ? request(() => api.POST('/api/v1/support/components', { body }))
        : request(() => api.PATCH('/api/v1/support/components/{id}', { params: { path: { id: current.id } }, body }));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['support', kind === 'category' ? 'categories' : 'components'] });
      onDone();
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <FormError error={save.error} />
      <Field label={t('support.config.name')} errorCode={errors.get('name')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={120}
            value={form.name}
            onChange={(event) => {
              setForm({ ...form, name: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('support.config.descriptionField')} errorCode={errors.get('description')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            maxLength={1000}
            value={form.description}
            onChange={(event) => {
              setForm({ ...form, description: event.target.value });
            }}
          />
        )}
      </Field>
      {kind === 'component' ? (
        <Field
          label={t('support.project')}
          hint={t('support.config.componentProjectHint')}
          errorCode={errors.get('projectId')}
          optional
        >
          {(control) => (
            <NativeSelect
              {...control}
              value={form.projectId}
              onChange={(event) => {
                setForm({ ...form, projectId: event.target.value });
              }}
            >
              <option value="">{t('support.config.global')}</option>
              {(projects.data?.pages.flatMap((page) => page.data) ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} · {project.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      <Checkbox
        label={t('support.config.active')}
        checked={form.active}
        onChange={(active) => {
          setForm({ ...form, active });
        }}
      />
      <SaveRow pending={save.isPending} onCancel={onDone} />
    </form>
  );
}

// ---- Business calendars ----

export function CalendarsSection() {
  const t = useTranslations('support.config');
  const calendars = useBusinessCalendars();
  const rows = calendars.data ?? [];
  return (
    <Section
      title={t('tabs.calendars')}
      addLabel={t('addCalendar')}
      renderForm={(close) => <CalendarForm onDone={close} />}
    >
      <QueryState query={calendars} empty={rows.length === 0}>
        <ul className="flex flex-col divide-y">
          {rows.map((calendar) => (
            <li key={calendar.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{calendar.name}</span>
                <span className="text-sm text-muted-foreground">
                  {calendar.workingHours
                    .map((entry) => `${t(`weekdays.${String(entry.weekday) as '1'}`)} ${entry.start}–${entry.end}`)
                    .join(' · ')}
                </span>
              </span>
              <EditButton
                name={calendar.name}
                renderForm={(close) => <CalendarForm current={calendar} onDone={close} />}
              />
            </li>
          ))}
        </ul>
      </QueryState>
    </Section>
  );
}

function CalendarForm({ current, onDone }: { readonly current?: BusinessCalendar; readonly onDone: () => void }) {
  const t = useTranslations();
  const id = useId();
  const queryClient = useQueryClient();
  const initialHours = new Map(current?.workingHours.map((entry) => [entry.weekday, entry]) ?? []);
  const [form, setForm] = useState({
    name: current?.name ?? '',
    timeZone: current?.timeZone ?? '',
    holidays: (current?.holidays ?? []).join('\n'),
    hours: WEEKDAYS.map((weekday) => {
      const entry = initialHours.get(weekday);
      return {
        weekday,
        on: current === undefined ? weekday <= 5 : entry !== undefined,
        start: entry?.start ?? '09:00',
        end: entry?.end ?? '17:00',
      };
    }),
  });
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        timeZone: form.timeZone.trim() === '' ? null : form.timeZone.trim(),
        workingHours: form.hours
          .filter((entry) => entry.on)
          .map((entry) => ({ weekday: entry.weekday, start: entry.start, end: entry.end })),
        holidays: form.holidays
          .split(/\s+/)
          .map((value) => value.trim())
          .filter((value) => value !== ''),
      };
      return current === undefined
        ? request(() => api.POST('/api/v1/support/calendars', { body }))
        : request(() => api.PATCH('/api/v1/support/calendars/{id}', { params: { path: { id: current.id } }, body }));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: supportKeys.calendars });
      onDone();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const setHour = (weekday: Weekday, patch: Partial<{ on: boolean; start: string; end: string }>) => {
    setForm({
      ...form,
      hours: form.hours.map((entry) => (entry.weekday === weekday ? { ...entry, ...patch } : entry)),
    });
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <FormError error={save.error} />
      <Field label={t('support.config.name')} errorCode={errors.get('name')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={120}
            value={form.name}
            onChange={(event) => {
              setForm({ ...form, name: event.target.value });
            }}
          />
        )}
      </Field>
      <Field
        label={t('support.config.timeZone')}
        hint={t('support.config.timeZoneHint')}
        errorCode={errors.get('timeZone')}
        optional
      >
        {(control) => (
          <Input
            {...control}
            maxLength={64}
            placeholder="Africa/Cairo"
            value={form.timeZone}
            onChange={(event) => {
              setForm({ ...form, timeZone: event.target.value });
            }}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('support.config.workingHours')}</legend>
        {errors.get('workingHours') === undefined ? null : (
          <p className="text-sm text-destructive">{t('fieldErrors.generic')}</p>
        )}
        {form.hours.map((entry) => {
          const day = t(`support.config.weekdays.${String(entry.weekday) as '1'}`);
          return (
            <div key={entry.weekday} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[10rem_1fr_1fr]">
              <Checkbox
                label={day}
                checked={entry.on}
                onChange={(on) => {
                  setHour(entry.weekday, { on });
                }}
              />
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-start-${String(entry.weekday)}`} className="text-xs">
                  {t('support.config.start')} · {day}
                </Label>
                <Input
                  id={`${id}-start-${String(entry.weekday)}`}
                  type="time"
                  disabled={!entry.on}
                  value={entry.start}
                  onChange={(event) => {
                    setHour(entry.weekday, { start: event.target.value });
                  }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-end-${String(entry.weekday)}`} className="text-xs">
                  {t('support.config.end')} · {day}
                </Label>
                <Input
                  id={`${id}-end-${String(entry.weekday)}`}
                  type="time"
                  disabled={!entry.on}
                  value={entry.end}
                  onChange={(event) => {
                    setHour(entry.weekday, { end: event.target.value });
                  }}
                />
              </div>
            </div>
          );
        })}
      </fieldset>
      <Field
        label={t('support.config.holidays')}
        hint={t('support.config.holidaysHint')}
        errorCode={errors.get('holidays')}
        optional
      >
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={form.holidays}
            onChange={(event) => {
              setForm({ ...form, holidays: event.target.value });
            }}
          />
        )}
      </Field>
      <SaveRow pending={save.isPending} onCancel={onDone} />
    </form>
  );
}

// ---- SLA policies ----

export function PoliciesSection() {
  const t = useTranslations('support.config');
  const policies = useSlaPolicies();
  const rows = policies.data ?? [];
  return (
    <Section title={t('tabs.policies')} addLabel={t('addPolicy')} renderForm={(close) => <PolicyForm onDone={close} />}>
      <QueryState query={policies} empty={rows.length === 0}>
        <ul className="flex flex-col divide-y" data-testid="sla-policies">
          {rows.map((policy) => (
            <li key={policy.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">
                  {policy.priority} · {policy.name}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t('targets', { first: policy.firstResponseMinutes, resolution: policy.resolutionMinutes })} ·{' '}
                  {policy.businessCalendar?.name ?? t('wallClock')}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <ActiveBadge active={policy.active} />
                <EditButton name={policy.name} renderForm={(close) => <PolicyForm current={policy} onDone={close} />} />
              </span>
            </li>
          ))}
        </ul>
      </QueryState>
    </Section>
  );
}

function PolicyForm({ current, onDone }: { readonly current?: SlaPolicy; readonly onDone: () => void }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const calendars = useBusinessCalendars();
  const [form, setForm] = useState({
    name: current?.name ?? '',
    priority: String(current?.priority ?? 100),
    severities: current?.match.severities ?? [],
    priorities: current?.match.priorities ?? [],
    firstResponseMinutes: String(current?.firstResponseMinutes ?? 60),
    resolutionMinutes: String(current?.resolutionMinutes ?? 480),
    atRiskThresholdPercent: String(current?.atRiskThresholdPercent ?? 75),
    businessCalendarId: current?.businessCalendar?.id ?? '',
    pauseStatuses: (current?.pauseStatuses ?? ['WAITING_FOR_CUSTOMER']).filter((status): status is Pausable =>
      (PAUSABLE as readonly string[]).includes(status),
    ),
    active: current?.active ?? true,
  });
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        priority: Number(form.priority),
        match: {
          severities: form.severities,
          priorities: form.priorities,
          projectIds: current?.match.projectIds ?? [],
          categoryIds: current?.match.categoryIds ?? [],
        },
        firstResponseMinutes: Number(form.firstResponseMinutes),
        resolutionMinutes: Number(form.resolutionMinutes),
        atRiskThresholdPercent: Number(form.atRiskThresholdPercent),
        businessCalendarId: form.businessCalendarId === '' ? null : form.businessCalendarId,
        pauseStatuses: form.pauseStatuses,
        active: form.active,
      };
      return current === undefined
        ? request(() => api.POST('/api/v1/support/sla-policies', { body }))
        : request(() => api.PATCH('/api/v1/support/sla-policies/{id}', { params: { path: { id: current.id } }, body }));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: supportKeys.policies });
      onDone();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const numberField = (
    key: 'priority' | 'firstResponseMinutes' | 'resolutionMinutes' | 'atRiskThresholdPercent',
    label: string,
    hint?: string,
  ) => (
    <Field label={label} hint={hint} errorCode={errors.get(key)}>
      {(control) => (
        <Input
          {...control}
          type="number"
          inputMode="numeric"
          min={key === 'priority' ? 0 : 1}
          value={form[key]}
          onChange={(event) => {
            setForm({ ...form, [key]: event.target.value });
          }}
        />
      )}
    </Field>
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <FormError error={save.error} />
      <Field label={t('support.config.name')} errorCode={errors.get('name')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={120}
            value={form.name}
            onChange={(event) => {
              setForm({ ...form, name: event.target.value });
            }}
          />
        )}
      </Field>
      {numberField('priority', t('support.config.order'), t('support.config.orderHint'))}
      <fieldset className="flex flex-wrap gap-x-4">
        <legend className="mb-1 text-sm font-medium">{t('support.config.matchSeverities')}</legend>
        {TICKET_SEVERITIES.map((severity) => (
          <Checkbox
            key={severity}
            label={t(`support.severities.${severity}`)}
            checked={form.severities.includes(severity)}
            onChange={(on) => {
              setForm({ ...form, severities: toggle(form.severities, severity, on) });
            }}
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-wrap gap-x-4">
        <legend className="mb-1 text-sm font-medium">{t('support.config.matchPriorities')}</legend>
        {TICKET_PRIORITIES.map((priority) => (
          <Checkbox
            key={priority}
            label={t(`support.priorities.${priority}`)}
            checked={form.priorities.includes(priority)}
            onChange={(on) => {
              setForm({ ...form, priorities: toggle(form.priorities, priority, on) });
            }}
          />
        ))}
        <p className="w-full text-xs text-muted-foreground">{t('support.config.matchAll')}</p>
      </fieldset>
      {numberField('firstResponseMinutes', t('support.config.firstResponseMinutes'))}
      {numberField('resolutionMinutes', t('support.config.resolutionMinutes'))}
      {numberField('atRiskThresholdPercent', t('support.config.atRisk'))}
      <Field label={t('support.config.calendar')} errorCode={errors.get('businessCalendarId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={form.businessCalendarId}
            onChange={(event) => {
              setForm({ ...form, businessCalendarId: event.target.value });
            }}
          >
            <option value="">{t('support.config.wallClock')}</option>
            {(calendars.data ?? []).map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium">{t('support.config.pauseStatuses')}</legend>
        {PAUSABLE.map((status) => (
          <Checkbox
            key={status}
            label={t(`support.statuses.${status}`)}
            checked={form.pauseStatuses.includes(status)}
            onChange={(on) => {
              setForm({ ...form, pauseStatuses: toggle(form.pauseStatuses, status, on) });
            }}
          />
        ))}
      </fieldset>
      <Checkbox
        label={t('support.config.active')}
        checked={form.active}
        onChange={(active) => {
          setForm({ ...form, active });
        }}
      />
      <SaveRow pending={save.isPending} onCancel={onDone} />
    </form>
  );
}

// ---- Escalation rules ----

export function RulesSection() {
  const t = useTranslations('support.config');
  const rules = useEscalationRules();
  const rows = rules.data ?? [];
  return (
    <Section title={t('tabs.rules')} addLabel={t('addRule')} renderForm={(close) => <RuleForm onDone={close} />}>
      <QueryState query={rules} empty={rows.length === 0}>
        <ul className="flex flex-col divide-y">
          {rows.map((rule) => (
            <li key={rule.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{rule.name}</span>
                <span className="text-sm text-muted-foreground">
                  {t('ruleSummary', { level: rule.level, trigger: t(`triggers.${rule.trigger}`) })}
                  {rule.trigger === 'FIRST_RESPONSE_BREACHED' ? '' : ` · ${String(rule.threshold)}`}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <ActiveBadge active={rule.active} />
                <EditButton name={rule.name} renderForm={(close) => <RuleForm current={rule} onDone={close} />} />
              </span>
            </li>
          ))}
        </ul>
      </QueryState>
    </Section>
  );
}

function RuleForm({ current, onDone }: { readonly current?: EscalationRule; readonly onDone: () => void }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const policies = useSlaPolicies();
  const [form, setForm] = useState({
    name: current?.name ?? '',
    slaPolicyId: current?.slaPolicyId ?? '',
    level: String(current?.level ?? 1),
    trigger: current?.trigger ?? 'RESOLUTION_ELAPSED_PERCENT',
    threshold: String(current?.threshold ?? 50),
    roles: (current?.notify.roles ?? []).filter((role): role is RoleKey =>
      (ROLE_KEYS as readonly string[]).includes(role),
    ),
    projectRoles: current?.notify.projectRoles ?? [],
    active: current?.active ?? true,
  });
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        slaPolicyId: form.slaPolicyId === '' ? null : form.slaPolicyId,
        match: current?.match ?? { severities: [], priorities: [], projectIds: [], categoryIds: [] },
        level: Number(form.level),
        trigger: form.trigger,
        threshold: form.trigger === 'FIRST_RESPONSE_BREACHED' ? 1 : Number(form.threshold),
        notify: { roles: form.roles, projectRoles: form.projectRoles, memberIds: current?.notify.memberIds ?? [] },
        active: form.active,
      };
      return current === undefined
        ? request(() => api.POST('/api/v1/support/escalation-rules', { body }))
        : request(() =>
            api.PATCH('/api/v1/support/escalation-rules/{id}', { params: { path: { id: current.id } }, body }),
          );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: supportKeys.rules });
      onDone();
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <FormError error={save.error} />
      <Field label={t('support.config.name')} errorCode={errors.get('name')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={120}
            value={form.name}
            onChange={(event) => {
              setForm({ ...form, name: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('support.config.policy')} errorCode={errors.get('slaPolicyId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={form.slaPolicyId}
            onChange={(event) => {
              setForm({ ...form, slaPolicyId: event.target.value });
            }}
          >
            <option value="">{t('support.config.anyPolicy')}</option>
            {(policies.data ?? []).map((policy) => (
              <option key={policy.id} value={policy.id}>
                {policy.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('support.config.level')} errorCode={errors.get('level')}>
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={1}
            max={5}
            value={form.level}
            onChange={(event) => {
              setForm({ ...form, level: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('support.config.trigger')} errorCode={errors.get('trigger')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={form.trigger}
            onChange={(event) => {
              const trigger = TRIGGERS.find((value) => value === event.target.value);
              if (trigger !== undefined) {
                setForm({ ...form, trigger });
              }
            }}
          >
            {TRIGGERS.map((trigger) => (
              <option key={trigger} value={trigger}>
                {t(`support.config.triggers.${trigger}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {form.trigger === 'FIRST_RESPONSE_BREACHED' ? null : (
        <Field
          label={t('support.config.threshold')}
          hint={t('support.config.thresholdHint')}
          errorCode={errors.get('threshold')}
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              value={form.threshold}
              onChange={(event) => {
                setForm({ ...form, threshold: event.target.value });
              }}
            />
          )}
        </Field>
      )}
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium">{t('support.config.notifyRoles')}</legend>
        {ROLE_KEYS.map((role) => (
          <Checkbox
            key={role}
            label={t(`support.config.roleNames.${role}`)}
            checked={form.roles.includes(role)}
            onChange={(on) => {
              setForm({ ...form, roles: toggle(form.roles, role, on) });
            }}
          />
        ))}
      </fieldset>
      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium">{t('support.config.notifyProjectRoles')}</legend>
        {PROJECT_ROLES.map((role) => (
          <Checkbox
            key={role}
            label={t(`projects.roles.${role}`)}
            checked={form.projectRoles.includes(role)}
            onChange={(on) => {
              setForm({ ...form, projectRoles: toggle(form.projectRoles, role, on) });
            }}
          />
        ))}
      </fieldset>
      <Checkbox
        label={t('support.config.active')}
        checked={form.active}
        onChange={(active) => {
          setForm({ ...form, active });
        }}
      />
      <SaveRow pending={save.isPending} onCancel={onDone} />
    </form>
  );
}
