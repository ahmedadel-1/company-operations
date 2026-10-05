'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import type { paths } from '@company-ops/api-client';
import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Input, NativeSelect } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import { useDateFormat } from '../lib/format';
import { useDepartments, useJobTitles } from '../lib/queries';
import { Field, fieldErrorsOf, FormError } from './form';

export type Employee = paths['/api/v1/employees/{id}']['get']['responses'][200]['content']['application/json']['data'];
export type Invitation =
  paths['/api/v1/employees']['post']['responses'][201]['content']['application/json']['data']['invitation'];
type CreateBody = NonNullable<paths['/api/v1/employees']['post']['requestBody']>['content']['application/json'];

export function DetailList({ items }: { readonly items: readonly (readonly [string, string | null])[] }) {
  const t = useTranslations('common');
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{value === null || value === '' ? t('none') : value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EmploymentStatusBadge({ status }: { readonly status: Employee['employmentStatus'] }) {
  const t = useTranslations('people.statuses');
  const tone = status === 'ACTIVE' ? 'success' : status === 'TERMINATED' ? 'danger' : 'warning';
  return <Badge tone={tone}>{t(status)}</Badge>;
}

export function MemberStatusBadge({ status }: { readonly status: Employee['memberStatus'] }) {
  const t = useTranslations('people.memberStatuses');
  const tone = status === 'ACTIVE' ? 'success' : status === 'DISABLED' ? 'danger' : 'neutral';
  return <Badge tone={tone}>{t(status)}</Badge>;
}

/** The single-use invitation link, shown once right after it was issued. */
export function InvitationNotice({ invitation }: { readonly invitation: Invitation }) {
  const t = useTranslations();
  const { dateTime } = useDateFormat();
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="flex flex-col gap-2 rounded-md border p-3">
      <p className="font-medium">{t('people.invitationTitle')}</p>
      <p className="text-sm text-muted-foreground">
        {t('people.invitationBody', { expiresAt: dateTime(invitation.expiresAt) })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          data-testid="invitation-url"
          className="min-w-0 flex-1 rounded bg-muted px-2 py-1 text-xs break-all select-all"
        >
          {invitation.url}
        </code>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(invitation.url).then(() => {
              setCopied(true);
            });
          }}
        >
          {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
    </div>
  );
}

interface EmployeeFormValues {
  fullName: string;
  employeeNumber: string;
  workEmail: string;
  phone: string;
  departmentId: string;
  jobTitleId: string;
  employmentType: Employee['employmentType'];
  joinDate: string;
  employmentStatus: Employee['employmentStatus'];
}

const EMPLOYMENT_TYPES: readonly Employee['employmentType'][] = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR'];
const EMPLOYMENT_STATUSES: readonly Employee['employmentStatus'][] = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'TERMINATED'];

function initialValues(employee: Employee | undefined): EmployeeFormValues {
  return {
    fullName: employee?.fullName ?? '',
    employeeNumber: employee?.employeeNumber ?? '',
    workEmail: employee?.workEmail ?? '',
    phone: employee?.phone ?? '',
    departmentId: employee?.department?.id ?? '',
    jobTitleId: employee?.jobTitle?.id ?? '',
    employmentType: employee?.employmentType ?? 'FULL_TIME',
    joinDate: employee?.joinDate ?? '',
    employmentStatus: employee?.employmentStatus ?? 'ACTIVE',
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/** Create (no `employee`) or edit an employee profile. */
export function EmployeeForm({
  employee,
  onCreated,
  onSaved,
}: {
  readonly employee?: Employee;
  readonly onCreated?: (result: { employee: Employee; invitation: Invitation }) => void;
  readonly onSaved?: () => void;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const departments = useDepartments();
  const jobTitles = useJobTitles();
  const [values, setValues] = useState(() => initialValues(employee));
  // Edits send only the fields the user changed, so values they cannot see (e.g. hidden contact
  // fields) are never overwritten.
  const [dirty, setDirty] = useState<ReadonlySet<keyof EmployeeFormValues>>(() => new Set());
  const set = <K extends keyof EmployeeFormValues>(key: K, value: EmployeeFormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty((current) => new Set(current).add(key));
  };

  const save = useMutation({
    mutationFn: async () => {
      const body: CreateBody = {
        fullName: values.fullName.trim(),
        workEmail: orNull(values.workEmail),
        phone: orNull(values.phone),
        departmentId: orNull(values.departmentId),
        jobTitleId: orNull(values.jobTitleId),
        employmentType: values.employmentType,
        joinDate: orNull(values.joinDate),
        ...(values.employeeNumber.trim() === '' ? {} : { employeeNumber: values.employeeNumber.trim() }),
      };
      if (employee === undefined) {
        const created = await request(() => api.POST('/api/v1/employees', { body }));
        onCreated?.(created.data);
        return;
      }
      const changes = Object.fromEntries(
        Object.entries({ ...body, employmentStatus: values.employmentStatus }).filter(([key]) =>
          dirty.has(key as keyof EmployeeFormValues),
        ),
      );
      if (Object.keys(changes).length > 0) {
        await request(() =>
          api.PATCH('/api/v1/employees/{id}', { params: { path: { id: employee.id } }, body: changes }),
        );
      }
      onSaved?.();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['employees'] }),
  });
  const errors = fieldErrorsOf(save.error);
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      <FormError error={save.error} />
      <Field label={t('people.name')} errorCode={errors.get('fullName')}>
        {(control) => (
          <Input
            {...control}
            required
            autoComplete="off"
            value={values.fullName}
            onChange={(event) => {
              set('fullName', event.target.value);
            }}
          />
        )}
      </Field>
      <Field
        label={t('people.employeeNumber')}
        hint={employee === undefined ? t('people.employeeNumberHint') : undefined}
        errorCode={errors.get('employeeNumber')}
        optional={employee === undefined}
      >
        {(control) => (
          <Input
            {...control}
            value={values.employeeNumber}
            onChange={(event) => {
              set('employeeNumber', event.target.value);
            }}
          />
        )}
      </Field>
      <div className="grid gap-4 lg:grid-cols-2">
        <Field label={t('people.workEmail')} errorCode={errors.get('workEmail')} optional>
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="off"
              value={values.workEmail}
              onChange={(event) => {
                set('workEmail', event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('people.phone')} errorCode={errors.get('phone')} optional>
          {(control) => (
            <Input
              {...control}
              type="tel"
              value={values.phone}
              onChange={(event) => {
                set('phone', event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('people.department')} errorCode={errors.get('departmentId')} optional>
          {(control) => (
            <NativeSelect
              {...control}
              value={values.departmentId}
              onChange={(event) => {
                set('departmentId', event.target.value);
              }}
            >
              <option value="">{t('common.none')}</option>
              {(departments.data ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('people.jobTitle')} errorCode={errors.get('jobTitleId')} optional>
          {(control) => (
            <NativeSelect
              {...control}
              value={values.jobTitleId}
              onChange={(event) => {
                set('jobTitleId', event.target.value);
              }}
            >
              <option value="">{t('common.none')}</option>
              {(jobTitles.data ?? []).map((jobTitle) => (
                <option key={jobTitle.id} value={jobTitle.id}>
                  {jobTitle.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('people.employmentType')} errorCode={errors.get('employmentType')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={values.employmentType}
              onChange={(event) => {
                const next = EMPLOYMENT_TYPES.find((type) => type === event.target.value);
                if (next !== undefined) {
                  set('employmentType', next);
                }
              }}
            >
              {EMPLOYMENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`people.employmentTypes.${type}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('people.joinDate')} errorCode={errors.get('joinDate')} optional>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={values.joinDate}
              onChange={(event) => {
                set('joinDate', event.target.value);
              }}
            />
          )}
        </Field>
        {employee === undefined ? null : (
          <Field label={t('people.employmentStatus')} errorCode={errors.get('employmentStatus')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={values.employmentStatus}
                onChange={(event) => {
                  const next = EMPLOYMENT_STATUSES.find((status) => status === event.target.value);
                  if (next !== undefined) {
                    set('employmentStatus', next);
                  }
                }}
              >
                {EMPLOYMENT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {t(`people.statuses.${status}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : employee === undefined ? t('common.create') : t('common.save')}
        </Button>
      </div>
    </form>
  );
}
