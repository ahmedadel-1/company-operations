'use client';

import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Badge } from '@company-ops/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';

import { StatusMessage } from '../../../../components/form';
import { DetailList } from '../../../../components/people';
import { ReportStatusBadge, usePersonLabel } from '../../../../components/projects';
import { ReportAttachments } from '../../../../components/report-attachments';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { useDateFormat } from '../../../../lib/format';
import { useDailyReport } from '../../../../lib/projects';
import type { DailyReport } from '../../../../lib/projects';
import { useCan } from '../../../../lib/session';

export default function DailyReportPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const report = useDailyReport(id);
  if (!can('daily_report.view') && !can('daily_report.submit')) {
    return <Forbidden />;
  }
  if (report.isPending) {
    return <ListSkeleton rows={5} />;
  }
  if (report.isError) {
    return (
      <ErrorState
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  }
  return <ReportDetail report={report.data} />;
}

function ReportDetail({ report }: { readonly report: DailyReport }) {
  const t = useTranslations();
  const { date, dateTime } = useDateFormat();
  const personLabel = usePersonLabel();
  const justSubmitted = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('submitted');
  const count = (value: number | null) => (value === null ? null : String(value));

  return (
    <>
      <Link
        href={`/projects/${report.project.id}#reports`}
        className="mb-3 inline-flex min-h-11 items-center gap-1 text-sm underline-offset-4 hover:underline"
      >
        <ArrowLeftIcon aria-hidden="true" className="size-4 rtl:rotate-180" />
        {report.project.name}
      </Link>
      <PageHeader
        title={t('reports.detailTitle', { date: date(report.reportDate) })}
        description={`${report.project.code} · ${personLabel(report.reporter)}`}
      />
      {justSubmitted ? (
        <div className="mb-4">
          <StatusMessage>{t('reports.submitted')}</StatusMessage>
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-2">
        <ReportStatusBadge status={report.systemStatus} />
        {report.followUpRequired ? <Badge tone="warning">{t('reports.followUp')}</Badge> : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t('reports.content')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <section>
              <h2 className="text-sm font-medium text-muted-foreground">{t('reports.workPerformed')}</h2>
              <p className="whitespace-pre-wrap">{report.workPerformed}</p>
            </section>
            <DetailList
              items={[
                [t('reports.problems'), report.problems],
                [t('reports.operationalNotes'), report.operationalNotes],
                [t('reports.customerNotes'), report.customerNotes],
                [t('reports.followUpNotes'), report.followUpNotes],
                [t('reports.processedRequests'), count(report.processedRequestsCount)],
                [t('reports.failedRequests'), count(report.failedRequestsCount)],
                [t('reports.submittedAtLabel'), dateTime(report.submittedAt)],
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <ReportAttachments
              reportId={report.id}
              canUpload={report.access.canAttach}
              canDelete={report.access.canDeleteAttachments}
            />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
