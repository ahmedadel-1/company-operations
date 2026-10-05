'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Input } from '@company-ops/ui/components/input';

import { DetailCard } from '../../../../components/commercial';
import { Field, FormError, StatusMessage, fieldErrorsOf } from '../../../../components/form';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import { useCommercialAction, useCommercialSettings } from '../../../../lib/commercial';
import type { CommercialSettings } from '../../../../lib/commercial';
import { useCanOrgWide } from '../../../../lib/session';

const KEYS = [
  'tenderReminderDays',
  'documentReminderDays',
  'contractReminderDays',
  'obligationReminderDays',
  'guaranteeReminderDays',
] as const;
type Key = (typeof KEYS)[number];

/** "30, 7, 1" to [30, 7, 1]; null when any entry is not a whole number of days in range. */
function parseDays(text: string): number[] | null {
  const parts = text
    .split(/[,،\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length > 10 || parts.some((part) => !/^\d{1,4}$/.test(part))) return null;
  const days = parts.map((part) => Number.parseInt(part, 10));
  return days.some((day) => day > 3650) ? null : [...new Set(days)].sort((a, b) => b - a);
}

export default function CommercialSettingsPage() {
  const t = useTranslations('commercial');
  const orgWide = useCanOrgWide();
  const allowed = orgWide('org.settings.manage');
  const settings = useCommercialSettings(allowed);
  if (!allowed) return <Forbidden />;
  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      {settings.isPending ? (
        <ListSkeleton rows={5} />
      ) : settings.isError ? (
        <ErrorState
          error={settings.error}
          onRetry={() => {
            void settings.refetch();
          }}
        />
      ) : (
        <SettingsForm key={settings.data.version} settings={settings.data} />
      )}
    </>
  );
}

function SettingsForm({ settings }: { readonly settings: CommercialSettings }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<Record<Key, string>>(() => {
    const initial = {} as Record<Key, string>;
    for (const key of KEYS) initial[key] = settings[key].join(', ');
    return initial;
  });
  const parsed = Object.fromEntries(KEYS.map((key) => [key, parseDays(draft[key])])) as Record<Key, number[] | null>;
  const invalid = KEYS.some((key) => parsed[key] === null);
  const errors = fieldErrorsOf(action.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (invalid) return;
    const body = { version: settings.version, ...Object.fromEntries(KEYS.map((key) => [key, parsed[key] ?? []])) };
    setSaved(false);
    action.mutate(() => request(() => api.PUT('/api/v1/commercial/settings', { body })), {
      onSuccess: () => {
        setSaved(true);
      },
    });
  };
  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4" data-testid="commercial-settings">
      <FormError error={action.error} />
      <DetailCard>
        {KEYS.map((key) => (
          <Field
            key={key}
            label={t(`settings.${key}`)}
            hint={t('settings.hint')}
            errorCode={parsed[key] === null ? 'invalid' : errors.get(key)}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                value={draft[key]}
                onChange={(event) => {
                  setDraft({ ...draft, [key]: event.target.value });
                }}
              />
            )}
          </Field>
        ))}
      </DetailCard>
      <div>
        <Button type="submit" disabled={action.isPending || invalid}>
          {action.isPending ? t('saving') : t('save')}
        </Button>
      </div>
      {saved ? <StatusMessage>{t('settings.saved')}</StatusMessage> : null}
    </form>
  );
}
