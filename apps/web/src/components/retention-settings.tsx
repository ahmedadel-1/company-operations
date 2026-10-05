'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Input } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import { useDateFormat } from '../lib/format';
import { githubKeys, useRetentionPolicies } from '../lib/github';
import type { RetentionPolicy, RetentionPreview } from '../lib/github';
import { Field, fieldErrorsOf, FormError, StatusMessage } from './form';
import { ErrorState, ListSkeleton } from './states';

/**
 * Retention of technical integration records (Jira and GitHub webhook deliveries, sync failures) and of
 * attendance coordinates (Phase 7). Without a policy nothing is deleted. Audit history and business links
 * are never purged.
 */
export function RetentionSettingsCard() {
  const t = useTranslations('retention');
  const policies = useRetentionPolicies(true);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{t('description')}</p>
        {policies.isPending ? (
          <ListSkeleton rows={2} />
        ) : policies.isError ? (
          <ErrorState error={policies.error} />
        ) : (
          <ul className="flex flex-col gap-4" data-testid="retention-policies">
            {policies.data.map((policy) => (
              <PolicyRow key={policy.category} policy={policy} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PolicyRow({ policy }: { readonly policy: RetentionPolicy }) {
  const t = useTranslations('retention');
  const { dateTime } = useDateFormat();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(policy.retainDays === null ? '' : String(policy.retainDays));
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const update = (data: RetentionPolicy[]) => {
    queryClient.setQueryData(githubKeys.retention, data);
  };
  const confirmed = preview !== null && preview.retainDays === Number(days);
  // Attendance coordinates are cleared (the attendance evidence row stays), with a 30-day minimum.
  const coordinates = policy.category === 'ATTENDANCE_COORDINATES';
  const dryRun = useMutation({
    mutationFn: () =>
      request(() =>
        api.GET('/api/v1/organization/retention-policies/{category}/preview', {
          params: { path: { category: policy.category }, query: { retainDays: Number(days) } },
        }),
      ),
    onSuccess: (result) => {
      setPreview(result.data);
    },
  });
  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.PUT('/api/v1/organization/retention-policies/{category}', {
          params: { path: { category: policy.category } },
          body: { retainDays: Number(days), version: policy.version },
        }),
      ),
    onSuccess: (result) => {
      update(result.data);
      setPreview(null);
      setMessage(t('saved'));
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      request(() =>
        api.DELETE('/api/v1/organization/retention-policies/{category}', {
          params: { path: { category: policy.category }, query: { version: policy.version ?? 0 } },
        }),
      ),
    onSuccess: (result) => {
      update(result.data);
      setDays('');
      setMessage(t('removed'));
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <li
      className="flex flex-col gap-2 rounded-md border p-3"
      data-testid="retention-policy"
      data-category={policy.category}
    >
      <h3 className="font-medium">{t(`categories.${policy.category}`)}</h3>
      <p className="text-muted-foreground">
        {policy.retainDays === null ? t('keptIndefinitely') : t('keptFor', { days: policy.retainDays })}
        {policy.lastPurgedAt === null
          ? ''
          : ` · ${t('lastPurged', { date: dateTime(policy.lastPurgedAt), count: policy.lastPurgedCount ?? 0 })}`}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
          event.preventDefault();
          setMessage(null);
          if (confirmed) {
            save.mutate();
          } else {
            dryRun.mutate();
          }
        }}
      >
        <div className="w-40">
          <Field
            label={t('days')}
            hint={t(coordinates ? 'daysHintCoordinates' : 'daysHint')}
            errorCode={errors.get('retainDays')}
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                inputMode="numeric"
                min={coordinates ? 30 : 7}
                max={3650}
                required
                value={days}
                onChange={(event) => {
                  setDays(event.target.value);
                  setPreview(null);
                }}
              />
            )}
          </Field>
        </div>
        <Button type="submit" size="sm" disabled={save.isPending || dryRun.isPending || days === ''}>
          {confirmed ? t('confirmSave') : t('save')}
        </Button>
        {policy.version === null ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              setMessage(null);
              remove.mutate();
            }}
          >
            {t('remove')}
          </Button>
        )}
      </form>
      {confirmed ? (
        <p role="status" data-testid="retention-preview">
          {t(coordinates ? 'previewCoordinates' : 'preview', { count: preview.eligible, days: preview.retainDays })}
        </p>
      ) : null}
      <FormError error={save.error ?? remove.error ?? dryRun.error} />
      {message === null ? null : <StatusMessage>{message}</StatusMessage>}
    </li>
  );
}
