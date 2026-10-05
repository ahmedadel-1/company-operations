'use client';

import { DownloadIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card } from '@company-ops/ui/components/card';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import {
  AdminCorrectionDialog,
  EventItem,
  RecordList,
  ReviewActions,
  SectionTabs,
  StatusBadge,
  useAttendanceFormat,
} from '../../../../components/attendance';
import { WithLinkParams } from '../../../../components/linked-filter';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { dateOf, oneOf, useLocationHash } from '../../../../lib/link-params';
import {
  ATTENDANCE_LIMITS,
  DAY_BUCKETS,
  daysBetween,
  exportUrl,
  RECORD_STATUSES,
  useAttendanceReviews,
  useTeamDay,
  useTeamRecords,
} from '../../../../lib/attendance';
import type { DayBucket, TeamDayRow, TeamRecordQuery } from '../../../../lib/attendance';
import { useDepartments } from '../../../../lib/queries';
import { useCan, useCanOrgWide, useSession } from '../../../../lib/session';

const TABS = ['day', 'records', 'reviews'] as const;
type Tab = (typeof TABS)[number];

/** Manager and HR views (`attendance.team`, scoped by the policy engine; `attendance.admin` org-wide). No payroll. */
export default function TeamAttendancePage() {
  const t = useTranslations('attendance');
  const can = useCan();
  const hash = useLocationHash();
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab = chosen ?? oneOf(hash, TABS) ?? 'day';
  if (!can('attendance.team')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('teamTitle')} description={t('teamDescription')} />
      <SectionTabs
        tabs={TABS}
        value={tab}
        onChange={setChosen}
        label={t('sections')}
        labelOf={(key) => t(`teamTabs.${key}`)}
      >
        {tab === 'day' ? (
          <WithLinkParams fallback={<ListSkeleton rows={4} />}>
            {(params) => <TeamDay params={params} />}
          </WithLinkParams>
        ) : tab === 'records' ? (
          <TeamRecords />
        ) : (
          <Reviews />
        )}
      </SectionTabs>
    </>
  );
}

function DepartmentSelect({
  id,
  value,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const departments = useDepartments();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t('department')}</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{common('all')}</option>
        {(departments.data ?? []).map((department) => (
          <option key={department.id} value={department.id}>
            {department.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function TeamDay({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const fmt = useAttendanceFormat();
  const me = useSession();
  const admin = useCanOrgWide()('attendance.admin');
  const [date, setDate] = useState(() => dateOf(params.get('date')) ?? '');
  const [departmentId, setDepartmentId] = useState('');
  const [bucket, setBucket] = useState<DayBucket | ''>(() => oneOf(params.get('bucket'), DAY_BUCKETS) ?? '');
  const day = useTeamDay(date, departmentId, bucket);
  const rows = day.data?.pages.flatMap((page) => page.data) ?? [];
  const correctable = (row: TeamDayRow) =>
    admin && row.employee.memberId !== me.activeOrganization.memberId && row.status !== 'UPCOMING';
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-3 lg:max-w-3xl">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="team-day-date">{t('date')}</Label>
          <Input
            id="team-day-date"
            type="date"
            value={date}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </div>
        <DepartmentSelect id="team-day-department" value={departmentId} onChange={setDepartmentId} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="team-day-bucket">{t('bucket')}</Label>
          <NativeSelect
            id="team-day-bucket"
            value={bucket}
            onChange={(event) => {
              setBucket(oneOf(event.target.value, DAY_BUCKETS) ?? '');
            }}
          >
            <option value="">{common('all')}</option>
            {DAY_BUCKETS.map((value) => (
              <option key={value} value={value}>
                {t(`buckets.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {day.isPending ? (
        <ListSkeleton />
      ) : day.isError ? (
        <ErrorState
          error={day.error}
          onRetry={() => {
            void day.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={t('teamEmpty')} />
      ) : (
        <>
          <Card className="hidden md:block">
            <Table aria-label={t('teamTabs.day')}>
              <thead>
                <TableRow>
                  <TableHead>{t('employee')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead>{t('checkIn')}</TableHead>
                  <TableHead>{t('checkOut')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{common('actions')}</span>
                  </TableHead>
                </TableRow>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TableRow key={row.employee.profileId} data-testid="team-day-row" data-status={row.status}>
                    <TableCell>
                      <span className="font-medium">{row.employee.fullName}</span>{' '}
                      <span className="text-muted-foreground">· {row.employee.employeeNumber}</span>
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusBadge status={row.status} />
                        {row.plannedMode === null || row.plannedMode === 'OFFICE' ? null : (
                          <Badge>{t(`modes.${row.plannedMode}`)}</Badge>
                        )}
                        {row.record?.needsReview === true ? <Badge tone="warning">{t('needsReview')}</Badge> : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.record === null ? '—' : fmt.time(row.record.checkInAt, row.record.timeZone)}
                    </TableCell>
                    <TableCell>
                      {row.record === null ? '—' : fmt.time(row.record.checkOutAt, row.record.timeZone)}
                    </TableCell>
                    <TableCell className="text-end">
                      <span className="flex flex-wrap justify-end gap-2">
                        {row.record === null ? null : (
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/attendance/records/${row.record.id}`}>
                              {t('open')}
                              <span className="sr-only">{row.employee.fullName}</span>
                            </Link>
                          </Button>
                        )}
                        {correctable(row) ? (
                          <AdminCorrectionDialog
                            target={{
                              profileId: row.employee.profileId,
                              workDate: row.date,
                              employeeName: row.employee.fullName,
                              version: row.record?.version ?? null,
                            }}
                          />
                        ) : null}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="flex flex-col gap-3 md:hidden" aria-label={t('teamTabs.day')}>
            {rows.map((row) => (
              <li
                key={row.employee.profileId}
                className="flex flex-col gap-2 rounded-lg border p-4"
                data-testid="team-day-card"
              >
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{row.employee.fullName}</span>
                  <StatusBadge status={row.status} />
                </span>
                {row.record === null ? null : (
                  <span className="text-sm text-muted-foreground">
                    {t('inOut', {
                      checkIn: fmt.time(row.record.checkInAt, row.record.timeZone),
                      checkOut: fmt.time(row.record.checkOutAt, row.record.timeZone),
                    })}
                  </span>
                )}
                <span className="flex flex-wrap gap-2">
                  {row.record === null ? null : (
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/attendance/records/${row.record.id}`}>{t('open')}</Link>
                    </Button>
                  )}
                  {correctable(row) ? (
                    <AdminCorrectionDialog
                      target={{
                        profileId: row.employee.profileId,
                        workDate: row.date,
                        employeeName: row.employee.fullName,
                        version: row.record?.version ?? null,
                      }}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
          {day.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={day.isFetchingNextPage}
              onClick={() => {
                void day.fetchNextPage();
              }}
            >
              {day.isFetchingNextPage ? common('loading') : common('loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

interface RecordDraft {
  readonly from: string;
  readonly to: string;
  readonly status: string;
  readonly departmentId: string;
  readonly needsReview: boolean;
  readonly late: boolean;
}

function TeamRecords() {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const [draft, setDraft] = useState<RecordDraft>({
    from: '',
    to: '',
    status: '',
    departmentId: '',
    needsReview: false,
    late: false,
  });
  const [filters, setFilters] = useState<TeamRecordQuery>({});
  const records = useTeamRecords(filters);
  const rows = records.data?.pages.flatMap((page) => page.data) ?? [];
  const status = RECORD_STATUSES.find((value) => value === draft.status);
  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters({
      ...(draft.from === '' ? {} : { from: draft.from }),
      ...(draft.to === '' ? {} : { to: draft.to }),
      ...(status === undefined ? {} : { status }),
      ...(draft.departmentId === '' ? {} : { departmentId: draft.departmentId }),
      ...(draft.needsReview ? { needsReview: 'true' as const } : {}),
      ...(draft.late ? { late: 'true' as const } : {}),
    });
  };
  const span = draft.from === '' || draft.to === '' ? null : daysBetween(draft.from, draft.to);
  const exportable = span !== null && span >= 0 && span < ATTENDANCE_LIMITS.maxExportDays;
  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={apply}
        role="search"
        aria-label={t('filters')}
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="records-from">{t('from')}</Label>
          <Input
            id="records-from"
            type="date"
            value={draft.from}
            onChange={(event) => {
              setDraft({ ...draft, from: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="records-to">{t('to')}</Label>
          <Input
            id="records-to"
            type="date"
            value={draft.to}
            onChange={(event) => {
              setDraft({ ...draft, to: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="records-status">{t('status')}</Label>
          <NativeSelect
            id="records-status"
            value={draft.status}
            onChange={(event) => {
              setDraft({ ...draft, status: event.target.value });
            }}
          >
            <option value="">{common('all')}</option>
            {RECORD_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`statuses.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <DepartmentSelect
          id="records-department"
          value={draft.departmentId}
          onChange={(departmentId) => {
            setDraft({ ...draft, departmentId });
          }}
        />
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.needsReview}
            onChange={(event) => {
              setDraft({ ...draft, needsReview: event.target.checked });
            }}
          />
          {t('onlyNeedsReview')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.late}
            onChange={(event) => {
              setDraft({ ...draft, late: event.target.checked });
            }}
          />
          {t('onlyLate')}
        </label>
        <Button type="submit" variant="outline">
          {common('apply')}
        </Button>
        {exportable ? (
          <Button asChild variant="outline">
            <a
              href={exportUrl({
                from: draft.from,
                to: draft.to,
                ...(status === undefined ? {} : { status: [status] }),
                departmentId: draft.departmentId,
              })}
              download
              data-testid="attendance-export"
            >
              <DownloadIcon aria-hidden="true" />
              {t('exportCsv')}
            </a>
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{t('exportHint', { days: ATTENDANCE_LIMITS.maxExportDays })}</p>
        )}
      </form>
      {records.isPending ? (
        <ListSkeleton />
      ) : records.isError ? (
        <ErrorState
          error={records.error}
          onRetry={() => {
            void records.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={t('recordsEmpty')} />
      ) : (
        <>
          <RecordList records={rows} label={t('teamTabs.records')} showEmployee />
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
        </>
      )}
    </div>
  );
}

function Reviews() {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const fmt = useAttendanceFormat();
  const reviews = useAttendanceReviews();
  const rows = reviews.data?.pages.flatMap((page) => page.data) ?? [];
  if (reviews.isPending) return <ListSkeleton />;
  if (reviews.isError) {
    return (
      <ErrorState
        error={reviews.error}
        onRetry={() => {
          void reviews.refetch();
        }}
      />
    );
  }
  if (rows.length === 0) return <EmptyState message={t('reviewsEmpty')} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t('reviewsHint')}</p>
      <ul className="flex flex-col gap-3" aria-label={t('teamTabs.reviews')}>
        {rows.map(({ event, record }) => (
          <li key={event.id} className="flex flex-col gap-2" data-testid="attendance-review-item">
            <span className="flex flex-wrap items-center gap-2 text-sm">
              <Link href={`/attendance/records/${record.id}`} className="font-medium underline underline-offset-4">
                {record.employee.fullName} · {fmt.date(record.workDate)}
              </Link>
            </span>
            <ol>
              <EventItem event={event} timeZone={record.timeZone}>
                <ReviewActions event={event} />
              </EventItem>
            </ol>
          </li>
        ))}
      </ul>
      {reviews.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={reviews.isFetchingNextPage}
          onClick={() => {
            void reviews.fetchNextPage();
          }}
        >
          {reviews.isFetchingNextPage ? common('loading') : common('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
