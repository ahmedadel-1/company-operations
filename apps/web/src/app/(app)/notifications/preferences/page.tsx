'use client';

import { LockIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { StatusMessage } from '../../../../components/form';
import { ErrorState, ListSkeleton, PageHeader, useErrorMessage } from '../../../../components/states';
import { useNotificationPreferences, useUpdateNotificationPreferences } from '../../../../lib/dashboard';
import type { NotificationCategory, PreferenceChange } from '../../../../lib/dashboard';

/**
 * The member's own notification channels per category (P8-8). Security notices and critical alerts
 * cannot be turned off; the server enforces the same locks and re-checks before every email.
 */
export default function NotificationPreferencesPage() {
  const t = useTranslations('preferences');
  const preferences = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  const message = useErrorMessage();
  const [saved, setSaved] = useState<string | null>(null);
  // Shown until the server answers, so the switch follows the click instead of springing back meanwhile.
  const [pending, setPending] = useState<PreferenceChange | null>(null);

  const toggle = (category: NotificationCategory, channel: PreferenceChange['channel'], enabled: boolean) => {
    setSaved(null);
    setPending({ category, channel, enabled });
    update.mutate([{ category, channel, enabled }], {
      onSuccess: () => {
        setSaved(t('saved'));
      },
      onSettled: () => {
        setPending(null);
      },
    });
  };
  const shown = (category: NotificationCategory, channel: PreferenceChange['channel'], stored: boolean) =>
    pending?.category === category && pending.channel === channel ? pending.enabled : stored;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {saved === null ? null : <StatusMessage>{saved}</StatusMessage>}
      {update.isError ? (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {message(update.error)}
        </p>
      ) : null}
      {preferences.isPending ? (
        <ListSkeleton rows={7} />
      ) : preferences.isError ? (
        <ErrorState
          error={preferences.error}
          onRetry={() => {
            void preferences.refetch();
          }}
        />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('title')} data-testid="notification-preferences">
          {preferences.data.items.map((item) => (
            <li
              key={item.category}
              className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
              data-testid="preference-row"
              data-category={item.category}
            >
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{t(`categories.${item.category}.title`)}</span>
                <span className="text-sm text-muted-foreground">{t(`categories.${item.category}.description`)}</span>
              </span>
              <span className="flex flex-wrap gap-4">
                <ChannelSwitch
                  label={t('inApp')}
                  category={t(`categories.${item.category}.title`)}
                  checked={shown(item.category, 'IN_APP', item.inApp)}
                  locked={item.inAppLocked}
                  disabled={update.isPending}
                  testId={`pref-${item.category}-IN_APP`}
                  onChange={(enabled) => {
                    toggle(item.category, 'IN_APP', enabled);
                  }}
                />
                <ChannelSwitch
                  label={t('email')}
                  category={t(`categories.${item.category}.title`)}
                  checked={shown(item.category, 'EMAIL', item.email)}
                  locked={item.emailLocked}
                  disabled={update.isPending}
                  testId={`pref-${item.category}-EMAIL`}
                  onChange={(enabled) => {
                    toggle(item.category, 'EMAIL', enabled);
                  }}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-sm text-muted-foreground">{t('criticalNote')}</p>
    </>
  );
}

function ChannelSwitch({
  label,
  category,
  checked,
  locked,
  disabled,
  testId,
  onChange,
}: {
  readonly label: string;
  readonly category: string;
  readonly checked: boolean;
  readonly locked: boolean;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onChange: (enabled: boolean) => void;
}) {
  const t = useTranslations('preferences');
  return (
    <label className="flex min-h-11 items-center gap-2 text-sm">
      <input
        type="checkbox"
        role="switch"
        className="size-4"
        checked={checked}
        disabled={locked || disabled}
        aria-describedby={locked ? `${testId}-locked` : undefined}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>
        {label}
        <span className="sr-only"> · {category}</span>
      </span>
      {locked ? (
        <span id={`${testId}-locked`} className="flex items-center gap-1 text-xs text-muted-foreground">
          <LockIcon aria-hidden="true" className="size-3" />
          {t('locked')}
        </span>
      ) : null}
    </label>
  );
}
