'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent } from '@company-ops/ui/components/card';
import { Label, NativeSelect } from '@company-ops/ui/components/input';

import { RunProgress, RunStatusBadge, useJiraErrorCode } from '../../../../../../components/jira-admin';
import { FormError, StatusMessage } from '../../../../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../../../components/states';
import { api, request } from '../../../../../../lib/api';
import { useDateFormat } from '../../../../../../lib/format';
import { ACTIVE_RUN_STATUSES, JIRA_RUN_STATUSES, jiraKeys, useJiraRun, useJiraRuns } from '../../../../../../lib/jira';
import type { JiraRun, JiraRunStatus } from '../../../../../../lib/jira';
import { useCanOrgWide } from '../../../../../../lib/session';

/** Sync history: every import / reconciliation run with progress, failures, cancel and retry. */
export default function JiraSyncPage() {
  const t = useTranslations('jira');
  const orgWide = useCanOrgWide();
  const [status, setStatus] = useState<JiraRunStatus | ''>('');
  const runs = useJiraRuns(status);
  if (!orgWide('integration.manage')) {
    return <Forbidden />;
  }
  const rows = runs.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <PageHeader
        title={t('runs.title')}
        description={t('runs.description')}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/integrations/jira">{t('runs.back')}</Link>
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-1.5 sm:max-w-xs">
        <Label htmlFor="jira-run-status">{t('runs.filter')}</Label>
        <NativeSelect
          id="jira-run-status"
          value={status}
          onChange={(event) => {
            setStatus(JIRA_RUN_STATUSES.find((value) => value === event.target.value) ?? '');
          }}
        >
          <option value="">{t('runs.all')}</option>
          {JIRA_RUN_STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(`runStatuses.${value}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {runs.isPending ? (
        <ListSkeleton rows={5} />
      ) : runs.isError ? (
        <ErrorState
          error={runs.error}
          onRetry={() => {
            void runs.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={t('runs.empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="jira-runs">
          {rows.map((run) => (
            <RunItem key={run.id} run={run} />
          ))}
        </ul>
      )}
      {runs.hasNextPage ? (
        <div className="mt-4">
          <Button
            type="button"
            variant="outline"
            disabled={runs.isFetchingNextPage}
            onClick={() => {
              void runs.fetchNextPage();
            }}
          >
            {t('runs.more')}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function RunItem({ run }: { readonly run: JiraRun }) {
  const t = useTranslations('jira');
  const { dateTime } = useDateFormat();
  const errorText = useJiraErrorCode();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = ACTIVE_RUN_STATUSES.includes(run.status);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: jiraKeys.all });
  const cancel = useMutation({
    mutationFn: () =>
      request(() => api.POST('/api/v1/integrations/jira/sync-runs/{id}/cancel', { params: { path: { id: run.id } } })),
    onSuccess: async () => {
      setNotice(t('runs.cancelRequested'));
      await invalidate();
    },
  });
  const retry = useMutation({
    mutationFn: () =>
      request(() => api.POST('/api/v1/integrations/jira/sync-runs/{id}/retry', { params: { path: { id: run.id } } })),
    onSuccess: async () => {
      setNotice(t('runs.retryQueued'));
      await invalidate();
    },
  });
  const canRetry = run.status === 'FAILED' || run.status === 'CANCELLED' || run.status === 'PARTIALLY_FAILED';
  return (
    <li>
      <Card>
        <CardContent className="flex flex-col gap-2 pt-4 text-sm" data-testid="jira-run">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">
              {run.jiraProjectKey} → {run.project.code} · {t(`runTypes.${run.type}`)}
            </span>
            <RunStatusBadge status={run.status} />
          </div>
          <RunProgress run={run} />
          <p className="text-muted-foreground">
            {t('runs.counts', {
              created: run.recordsCreated,
              updated: run.recordsUpdated,
              unchanged: run.recordsUnchanged,
              failed: run.recordsFailed,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('runs.queuedAt', { date: dateTime(run.createdAt) })}
            {run.finishedAt === null ? '' : ` · ${t('runs.finishedAt', { date: dateTime(run.finishedAt) })}`}
            {run.requestedBy?.fullName == null ? '' : ` · ${run.requestedBy.fullName}`}
          </p>
          {run.errorCode === null ? null : <p className="text-destructive">{errorText(run.errorCode)}</p>}
          {notice === null ? null : <StatusMessage>{notice}</StatusMessage>}
          <FormError error={cancel.error ?? retry.error} />
          <div className="flex flex-wrap gap-2">
            {active && !run.cancelRequested ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => {
                  cancel.mutate();
                }}
              >
                {t('runs.cancel')}
              </Button>
            ) : null}
            {canRetry ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={retry.isPending}
                onClick={() => {
                  retry.mutate();
                }}
              >
                {t('runs.retry')}
              </Button>
            ) : null}
            {run.recordsFailed > 0 || run.errorCode !== null ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={open}
                onClick={() => {
                  setOpen((value) => !value);
                }}
              >
                {open ? t('runs.hideFailures') : t('runs.showFailures')}
              </Button>
            ) : null}
          </div>
          {open ? <RunFailures runId={run.id} /> : null}
        </CardContent>
      </Card>
    </li>
  );
}

function RunFailures({ runId }: { readonly runId: string }) {
  const t = useTranslations('jira');
  const errorText = useJiraErrorCode();
  const detail = useJiraRun(runId);
  if (detail.isPending) {
    return <ListSkeleton rows={2} />;
  }
  if (detail.isError) {
    return <ErrorState error={detail.error} />;
  }
  if (detail.data.failures.length === 0) {
    return <p className="text-muted-foreground">{t('runs.noFailures')}</p>;
  }
  return (
    <ul className="flex flex-col gap-1" aria-label={t('runs.failures')}>
      {detail.data.failures.map((failure) => (
        <li key={failure.id} className="rounded-md border p-2">
          {failure.jiraIssueId === null ? '' : `#${failure.jiraIssueId} · `}
          {errorText(failure.errorCode)} · {t(`failureClasses.${failure.classification}`)}
        </li>
      ))}
    </ul>
  );
}
