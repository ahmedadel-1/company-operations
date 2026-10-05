'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { enabledLocales, isLocale } from '@company-ops/i18n';
import type { paths } from '@company-ops/api-client';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent } from '@company-ops/ui/components/card';
import { Input, NativeSelect } from '@company-ops/ui/components/input';

import { Field, fieldErrorsOf, FormError, StatusMessage } from '../../../../components/form';
import { RetentionSettingsCard } from '../../../../components/retention-settings';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import { queryKeys, useOrganization } from '../../../../lib/queries';
import { useCan } from '../../../../lib/session';

type Organization = paths['/api/v1/organization']['get']['responses'][200]['content']['application/json']['data'];

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export default function OrganizationPage() {
  const t = useTranslations('organization');
  const can = useCan();
  const organization = useOrganization();
  if (!can('org.settings.manage')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('title')} />
      {organization.isPending ? (
        <ListSkeleton rows={4} />
      ) : organization.isError ? (
        <ErrorState
          error={organization.error}
          onRetry={() => {
            void organization.refetch();
          }}
        />
      ) : (
        <div className="flex flex-col gap-6">
          <OrganizationForm organization={organization.data} />
          <RetentionSettingsCard />
        </div>
      )}
    </>
  );
}

function OrganizationForm({ organization }: { readonly organization: Organization }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [name, setName] = useState(organization.name);
  const [timeZone, setTimeZone] = useState(organization.timeZone);
  const [workWeek, setWorkWeek] = useState<ReadonlySet<number>>(() => new Set(organization.workWeek));
  const [defaultLocale, setDefaultLocale] = useState(organization.defaultLocale);

  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.PATCH('/api/v1/organization', {
          body: { name: name.trim(), timeZone: timeZone.trim(), workWeek: [...workWeek].sort(), defaultLocale },
        }),
      ),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.organization, result.data);
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Card>
      <CardContent>
        <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4" noValidate>
          <FormError error={save.error} />
          <Field label={t('organization.name')} errorCode={errors.get('name')}>
            {(control) => (
              <Input
                {...control}
                required
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label={t('organization.timeZone')}
            hint={t('organization.timeZoneHint')}
            errorCode={errors.get('timeZone')}
          >
            {(control) => (
              <Input
                {...control}
                required
                value={timeZone}
                onChange={(event) => {
                  setTimeZone(event.target.value);
                }}
              />
            )}
          </Field>
          <fieldset
            className="flex flex-col gap-2"
            aria-describedby={errors.has('workWeek') ? 'work-week-error' : undefined}
          >
            <legend className="mb-1.5 text-sm font-medium">{t('organization.workWeek')}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {WEEKDAYS.map((day) => (
                <label key={day} className="inline-flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={workWeek.has(day)}
                    onChange={(event) => {
                      const next = new Set(workWeek);
                      if (event.target.checked) {
                        next.add(day);
                      } else {
                        next.delete(day);
                      }
                      setWorkWeek(next);
                    }}
                  />
                  {t(`organization.weekdays.${String(day) as '1'}`)}
                </label>
              ))}
            </div>
            {errors.has('workWeek') ? (
              <p id="work-week-error" className="text-sm text-destructive">
                {t('fieldErrors.too_small')}
              </p>
            ) : null}
          </fieldset>
          <Field label={t('organization.defaultLocale')} errorCode={errors.get('defaultLocale')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={defaultLocale}
                onChange={(event) => {
                  if (isLocale(event.target.value)) {
                    setDefaultLocale(event.target.value);
                  }
                }}
              >
                {enabledLocales.map((option) => (
                  <option key={option} value={option} lang={option}>
                    {t(`locales.${option}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
            {save.isSuccess ? <StatusMessage>{t('organization.saved')}</StatusMessage> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
