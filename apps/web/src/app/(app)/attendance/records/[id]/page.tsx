'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';

import {
  AdminCorrectionDialog,
  EventItem,
  ReviewActions,
  StatusBadge,
  useAttendanceFormat,
} from '../../../../../components/attendance';
import { ErrorState, ListSkeleton, PageHeader } from '../../../../../components/states';
import { useAttendanceRecord } from '../../../../../lib/attendance';
import type { AttendanceRecordDetail } from '../../../../../lib/attendance';

export default function AttendanceRecordPage() {
  const { id } = useParams<{ id: string }>();
  const detail = useAttendanceRecord(id);
  if (detail.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (detail.isError) {
    return (
      <ErrorState
        error={detail.error}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }
  return <RecordDetail detail={detail.data} />;
}

function RecordDetail({ detail }: { readonly detail: AttendanceRecordDetail }) {
  const t = useTranslations('attendance');
  const fmt = useAttendanceFormat();
  const { record } = detail;
  const zone = record.timeZone;
  return (
    <>
      <PageHeader
        title={t('recordTitle', { name: record.employee.fullName, date: fmt.date(record.workDate) })}
        description={`${record.employee.employeeNumber}${record.employee.department === null ? '' : ` · ${record.employee.department.name}`}`}
        actions={
          detail.canCorrect ? (
            <AdminCorrectionDialog
              target={{
                profileId: record.employee.profileId,
                workDate: record.workDate,
                employeeName: record.employee.fullName,
                version: record.version,
              }}
            />
          ) : undefined
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1" data-testid="attendance-record-summary">
          <CardHeader>
            <CardTitle>{t('summary')}</CardTitle>
            <StatusBadge status={record.status} />
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 text-sm">
              <Row label={t('shift')}>
                {record.shift === null
                  ? t('noShift')
                  : t('shiftLine', {
                      name: record.shift.name,
                      start: fmt.time(record.scheduledStartAt, zone),
                      end: fmt.time(record.scheduledEndAt, zone),
                    })}
              </Row>
              <Row label={t('mode')}>{record.mode === null ? '—' : t(`modes.${record.mode}`)}</Row>
              <Row label={t('checkIn')}>
                {fmt.time(record.checkInAt, zone)}
                {record.checkInLocation === null ? null : ` · ${record.checkInLocation.name}`}
              </Row>
              <Row label={t('checkOut')}>
                {fmt.time(record.checkOutAt, zone)}
                {record.checkOutLocation === null ? null : ` · ${record.checkOutLocation.name}`}
              </Row>
              <Row label={t('worked')}>{fmt.duration(record.workedMinutes)}</Row>
              <Row label={t('late')}>{t('minutes', { minutes: record.lateMinutes })}</Row>
              <Row label={t('earlyLeave')}>{t('minutes', { minutes: record.earlyLeaveMinutes })}</Row>
              <Row label={t('timeZone')}>
                <span dir="ltr">{zone}</span>
              </Row>
            </dl>
            <div className="mt-3 flex flex-wrap gap-1">
              {record.needsReview ? <Badge tone="warning">{t('needsReview')}</Badge> : null}
              {record.adjusted ? <Badge>{t('adjusted')}</Badge> : null}
            </div>
            {record.sourceRequestId === null ? null : (
              <Link
                href={`/requests/${record.sourceRequestId}`}
                className="mt-3 inline-block text-sm underline underline-offset-4"
              >
                {t('sourceRequest')}
              </Link>
            )}
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('evidence')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">{t('evidenceHint')}</p>
            {detail.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noEvents')}</p>
            ) : (
              <ol className="flex flex-col gap-3" aria-label={t('evidence')}>
                {detail.events.map((event) => (
                  <EventItem key={event.id} event={event} timeZone={zone}>
                    {detail.canReview && event.reviewStatus === 'PENDING_REVIEW' ? (
                      <ReviewActions event={event} />
                    ) : null}
                  </EventItem>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
