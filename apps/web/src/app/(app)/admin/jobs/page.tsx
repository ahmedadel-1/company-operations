'use client';

import { useTranslations } from 'next-intl';

import { Card } from '@company-ops/ui/components/card';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { useDateFormat } from '../../../../lib/format';
import { useFailedJobs } from '../../../../lib/queries';
import { useCan } from '../../../../lib/session';

export default function SystemJobsPage() {
  const t = useTranslations();
  const can = useCan();
  const jobs = useFailedJobs();
  const { dateTime } = useDateFormat();
  if (!can('org.settings.manage')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('jobs.title')} description={t('jobs.description')} />
      {jobs.isPending ? (
        <ListSkeleton />
      ) : jobs.isError ? (
        <ErrorState
          error={jobs.error}
          onRetry={() => {
            void jobs.refetch();
          }}
        />
      ) : jobs.data.length === 0 ? (
        <EmptyState message={t('jobs.empty')} />
      ) : (
        <>
          <ul className="flex flex-col gap-3 md:hidden">
            {jobs.data.map((job) => (
              <li key={`${job.source}:${job.id}`} className="flex flex-col gap-1 rounded-lg border p-4 text-sm">
                <code className="text-xs">{job.queue === null ? job.name : `${job.queue} / ${job.name}`}</code>
                <span className="text-muted-foreground">
                  {t(`jobs.sources.${job.source}`)} · {t('jobs.attempts')}: {job.attempts}
                  {job.failedAt === null ? '' : ` · ${dateTime(job.failedAt)}`}
                </span>
                {job.error === null ? null : <span className="break-words">{job.error}</span>}
              </li>
            ))}
          </ul>
          <Card className="hidden md:block">
            <Table>
              <thead>
                <TableRow>
                  <TableHead>{t('jobs.source')}</TableHead>
                  <TableHead>{t('jobs.name')}</TableHead>
                  <TableHead>{t('jobs.attempts')}</TableHead>
                  <TableHead>{t('jobs.error')}</TableHead>
                  <TableHead>{t('jobs.failedAt')}</TableHead>
                </TableRow>
              </thead>
              <tbody>
                {jobs.data.map((job) => (
                  <TableRow key={`${job.source}:${job.id}`}>
                    <TableCell>{t(`jobs.sources.${job.source}`)}</TableCell>
                    <TableCell>
                      <code className="text-xs">{job.queue === null ? job.name : `${job.queue} / ${job.name}`}</code>
                    </TableCell>
                    <TableCell>{job.attempts}</TableCell>
                    <TableCell className="max-w-md text-sm break-words">{job.error ?? t('common.none')}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {job.failedAt === null ? t('common.none') : dateTime(job.failedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
