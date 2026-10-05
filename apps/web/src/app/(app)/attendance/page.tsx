'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';

import {
  CheckPanel,
  CorrectionDialog,
  RecordList,
  SectionTabs,
  useAttendanceFormat,
} from '../../../components/attendance';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { useAttendanceToday, useMyAttendance, useMyCorrections } from '../../../lib/attendance';
import { useDateFormat } from '../../../lib/format';
import type { AttendanceCorrection } from '../../../lib/attendance';
import { useCan } from '../../../lib/session';

const TABS = ['today', 'history', 'corrections'] as const;
type Tab = (typeof TABS)[number];

export default function AttendancePage() {
  const t = useTranslations('attendance');
  const can = useCan();
  const allowed = can('attendance.self');
  const [tab, setTab] = useState<Tab>('today');
  const today = useAttendanceToday(allowed);
  if (!allowed) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          can('attendance.team') ? (
            <Button asChild variant="outline">
              <Link href="/attendance/team">{t('teamTitle')}</Link>
            </Button>
          ) : undefined
        }
      />
      <SectionTabs tabs={TABS} value={tab} onChange={setTab} label={t('sections')} labelOf={(key) => t(`tabs.${key}`)}>
        {tab === 'today' ? (
          today.isPending ? (
            <ListSkeleton rows={3} />
          ) : today.isError ? (
            <ErrorState
              error={today.error}
              onRetry={() => {
                void today.refetch();
              }}
            />
          ) : (
            <div className="flex flex-col gap-4">
              <CheckPanel today={today.data} />
              {today.data.eligible ? <CorrectionDialog today={today.data.workDate} /> : null}
            </div>
          )
        ) : tab === 'history' ? (
          <History />
        ) : (
          <Corrections today={today.data?.workDate ?? null} />
        )}
      </SectionTabs>
    </>
  );
}

function History() {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const records = useMyAttendance();
  const rows = records.data?.pages.flatMap((page) => page.data) ?? [];
  if (records.isPending) return <ListSkeleton />;
  if (records.isError) {
    return (
      <ErrorState
        error={records.error}
        onRetry={() => {
          void records.refetch();
        }}
      />
    );
  }
  if (rows.length === 0) return <EmptyState message={t('historyEmpty')} />;
  return (
    <div className="flex flex-col gap-4">
      <RecordList records={rows} label={t('tabs.history')} />
      {records.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={records.isFetchingNextPage}
          onClick={() => {
            void records.fetchNextPage();
          }}
        >
          {records.isFetchingNextPage ? common('loading') : common('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function Corrections({ today }: { readonly today: string | null }) {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const corrections = useMyCorrections();
  const rows = corrections.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <div className="flex flex-col gap-4">
      {today === null ? null : <CorrectionDialog today={today} />}
      {corrections.isPending ? (
        <ListSkeleton rows={3} />
      ) : corrections.isError ? (
        <ErrorState
          error={corrections.error}
          onRetry={() => {
            void corrections.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={t('correctionsEmpty')} />
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('tabs.corrections')}>
          {rows.map((correction) => (
            <CorrectionItem key={correction.id} correction={correction} />
          ))}
        </ul>
      )}
      {corrections.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={corrections.isFetchingNextPage}
          onClick={() => {
            void corrections.fetchNextPage();
          }}
        >
          {corrections.isFetchingNextPage ? common('loading') : common('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

const CORRECTION_TONE = {
  PENDING: 'neutral',
  APPLIED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
  REVERTED: 'warning',
} as const;

function CorrectionItem({ correction }: { readonly correction: AttendanceCorrection }) {
  const t = useTranslations('attendance');
  const fmt = useAttendanceFormat();
  const { dateTime } = useDateFormat();
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border p-4 text-sm"
      data-testid="attendance-correction"
      data-status={correction.status}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{fmt.date(correction.workDate)}</span>
        <Badge tone={CORRECTION_TONE[correction.status]}>{t(`correctionStatuses.${correction.status}`)}</Badge>
      </span>
      <span>{t(`reasons.${correction.reasonCode}`)}</span>
      <span className="text-muted-foreground">
        {t('requestedTimes', {
          checkIn: correction.requestedCheckInAt === null ? '—' : dateTime(correction.requestedCheckInAt),
          checkOut: correction.requestedCheckOutAt === null ? '—' : dateTime(correction.requestedCheckOutAt),
        })}
      </span>
      <Link href={`/requests/${correction.request.id}`} className="self-start underline underline-offset-4">
        {t('viewRequest', { number: correction.request.number })}
      </Link>
    </li>
  );
}
