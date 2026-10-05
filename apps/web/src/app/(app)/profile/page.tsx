'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { enabledLocales, isLocale } from '@company-ops/i18n';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Input, NativeSelect } from '@company-ops/ui/components/input';

import { AvatarCard } from '../../../components/avatar';
import { Field, fieldErrorsOf, FormError, StatusMessage } from '../../../components/form';
import { writeLocaleCookie } from '../../../components/shell';
import { ErrorState, ListSkeleton, PageHeader } from '../../../components/states';
import { api, request } from '../../../lib/api';
import { queryKeys, useOwnProfile } from '../../../lib/queries';
import type { Me } from '../../../lib/session';
import { useSession } from '../../../lib/session';
import { DetailList } from '../../../components/people';

type Profile = NonNullable<ReturnType<typeof useOwnProfile>['data']>;

export default function ProfilePage() {
  const t = useTranslations('profile');
  const me = useSession();
  const profile = useOwnProfile();

  return (
    <>
      <PageHeader title={t('title')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <AccountCard me={me} />
        {profile.isPending ? (
          <ListSkeleton rows={3} />
        ) : profile.isError ? (
          <ErrorState
            error={profile.error}
            onRetry={() => {
              void profile.refetch();
            }}
          />
        ) : profile.data === null ? (
          <Card>
            <CardContent>
              <p className="text-muted-foreground">{t('noProfile')}</p>
            </CardContent>
          </Card>
        ) : (
          <>
            <AvatarCard employee={profile.data} canChange />
            <EmploymentCard profile={profile.data} />
            <PreferencesForm profile={profile.data} />
          </>
        )}
      </div>
    </>
  );
}

function AccountCard({ me }: { readonly me: Me }) {
  const t = useTranslations('profile');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailList
          items={[
            [t('displayName'), me.user.displayName],
            [t('email'), me.user.email],
          ]}
        />
      </CardContent>
    </Card>
  );
}

function EmploymentCard({ profile }: { readonly profile: Profile }) {
  const t = useTranslations();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile.employment')}</CardTitle>
      </CardHeader>
      <CardContent>
        <DetailList
          items={[
            [t('people.employeeNumber'), profile.employeeNumber],
            [t('people.department'), profile.department?.name ?? null],
            [t('people.jobTitle'), profile.jobTitle?.name ?? null],
            [t('people.manager'), profile.manager?.fullName ?? null],
            [t('people.workEmail'), profile.workEmail],
          ]}
        />
      </CardContent>
    </Card>
  );
}

function PreferencesForm({ profile }: { readonly profile: Profile }) {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [timeZone, setTimeZone] = useState(profile.timeZone ?? '');
  const [locale, setLocale] = useState(profile.locale ?? '');

  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.PATCH('/api/v1/me/profile', {
          body: {
            phone: phone.trim() === '' ? null : phone.trim(),
            timeZone: timeZone.trim() === '' ? null : timeZone.trim(),
            locale: isLocale(locale) ? locale : null,
          },
        }),
      ),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.ownProfile, result.data);
      if (result.data.locale !== null && isLocale(result.data.locale)) {
        writeLocaleCookie(result.data.locale);
        router.refresh();
      }
      await queryClient.invalidateQueries({ queryKey: ['employees'] });
    },
  });
  const errors = fieldErrorsOf(save.error);

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>{t('profile.preferences')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4" noValidate>
          <FormError error={save.error} />
          <Field label={t('profile.phone')} errorCode={errors.get('phone')} optional>
            {(control) => (
              <Input
                {...control}
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label={t('profile.timeZone')}
            hint={t('profile.timeZoneHint')}
            errorCode={errors.get('timeZone')}
            optional
          >
            {(control) => (
              <Input
                {...control}
                value={timeZone}
                onChange={(event) => {
                  setTimeZone(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('profile.language')} errorCode={errors.get('locale')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={locale}
                onChange={(event) => {
                  setLocale(event.target.value);
                }}
              >
                <option value="">{t('profile.useOrganizationDefault')}</option>
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
            {save.isSuccess ? <StatusMessage>{t('profile.saved')}</StatusMessage> : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
