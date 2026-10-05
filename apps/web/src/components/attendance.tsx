'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, LogInIcon, LogOutIcon, MapPinIcon, ShieldCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, NativeSelect, Textarea } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { api, ApiError, request } from '../lib/api';
import { ADJUSTMENT_REASONS, attendanceKeys, ATTENDANCE_LIMITS, shiftDate } from '../lib/attendance';
import type {
  AdjustmentReason,
  AttendanceEvent,
  AttendanceRecord,
  AttendanceToday,
  DayStatus,
  LocationReport,
  RecordStatus,
} from '../lib/attendance';
import { requestKeys } from '../lib/requests';
import { Field, fieldErrorsOf, FormError, StatusMessage } from './form';
import { useErrorMessage } from './states';

// ---- Location (SECURITY §9): read once per explicit tap, never watched or tracked ----

export type LocationProblem = 'PERMISSION_DENIED' | 'UNAVAILABLE' | 'TIMEOUT' | 'UNSUPPORTED' | 'INSECURE' | 'STALE';
type OkReport = Extract<LocationReport, { status: 'OK' }>;
type Acquired =
  { readonly kind: 'ok'; readonly report: OkReport } | { readonly kind: 'problem'; readonly problem: LocationProblem };

const LOCATION_TIMEOUT_MS = 15_000;
/** A cached fix older than this is not evidence of where the employee is now. */
const STALE_AFTER_MS = 2 * 60_000;

/** One high-accuracy position request; resolves (never rejects) with the position or the reason it failed. */
export function readLocation(): Promise<Acquired> {
  if (typeof window === 'undefined' || !window.isSecureContext) {
    return Promise.resolve({ kind: 'problem', problem: 'INSECURE' });
  }
  if (!('geolocation' in navigator)) {
    return Promise.resolve({ kind: 'problem', problem: 'UNSUPPORTED' });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (Date.now() - position.timestamp > STALE_AFTER_MS) {
          resolve({ kind: 'problem', problem: 'STALE' });
          return;
        }
        resolve({
          kind: 'ok',
          report: {
            status: 'OK',
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
          },
        });
      },
      (error) => {
        const problem: LocationProblem =
          error.code === error.PERMISSION_DENIED
            ? 'PERMISSION_DENIED'
            : error.code === error.TIMEOUT
              ? 'TIMEOUT'
              : 'UNAVAILABLE';
        resolve({ kind: 'problem', problem });
      },
      { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}

/** What the server is told when the employee continues without a position (its policy decides). */
function problemReport(problem: LocationProblem): LocationReport {
  switch (problem) {
    case 'PERMISSION_DENIED':
    case 'TIMEOUT':
      return { status: problem };
    case 'UNSUPPORTED':
    case 'INSECURE':
      return { status: 'UNSUPPORTED' };
    case 'UNAVAILABLE':
    case 'STALE':
      return { status: 'UNAVAILABLE' };
  }
}

// ---- Formatting ----

export function useAttendanceFormat() {
  const format = useFormatter();
  const t = useTranslations('attendance');
  return {
    time: (value: string | null, timeZone: string) =>
      value === null ? '—' : format.dateTime(new Date(value), { timeStyle: 'short', timeZone }),
    dateTime: (value: string, timeZone: string) =>
      format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short', timeZone }),
    date: (value: string) => format.dateTime(new Date(`${value}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }),
    longDate: (value: string) =>
      format.dateTime(new Date(`${value}T00:00:00Z`), {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    duration: (minutes: number | null) =>
      minutes === null ? '—' : t('duration', { hours: Math.floor(minutes / 60), minutes: minutes % 60 }),
  };
}

const STATUS_TONE: Readonly<Record<RecordStatus | DayStatus, 'neutral' | 'success' | 'warning' | 'danger'>> = {
  OPEN: 'neutral',
  CHECKED_IN: 'neutral',
  COMPLETE: 'success',
  MISSING_CHECKOUT: 'warning',
  EXCUSED: 'neutral',
  ON_LEAVE: 'neutral',
  ON_MISSION: 'neutral',
  ABSENT: 'danger',
  SCHEDULED: 'neutral',
  NOT_STARTED: 'neutral',
  UPCOMING: 'neutral',
  OFF_DAY: 'neutral',
  NO_SCHEDULE: 'neutral',
};

export function StatusBadge({ status }: { readonly status: RecordStatus | DayStatus }) {
  const t = useTranslations('attendance.statuses');
  return (
    <Badge tone={STATUS_TONE[status]} data-testid="attendance-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

function RecordFlags({ record }: { readonly record: AttendanceRecord }) {
  const t = useTranslations('attendance');
  return (
    <span className="flex flex-wrap gap-1">
      {record.needsReview ? <Badge tone="warning">{t('needsReview')}</Badge> : null}
      {record.adjusted ? <Badge>{t('adjusted')}</Badge> : null}
      {record.lateMinutes > 0 ? <Badge tone="warning">{t('lateBy', { minutes: record.lateMinutes })}</Badge> : null}
      {record.earlyLeaveMinutes > 0 ? (
        <Badge tone="warning">{t('earlyBy', { minutes: record.earlyLeaveMinutes })}</Badge>
      ) : null}
    </span>
  );
}

/** Records as a table from 768 px and as cards below (UI_UX.md §6). */
export function RecordList({
  records,
  label,
  showEmployee = false,
}: {
  readonly records: readonly AttendanceRecord[];
  readonly label: string;
  readonly showEmployee?: boolean;
}) {
  const t = useTranslations('attendance');
  const fmt = useAttendanceFormat();
  return (
    <>
      <Card className="hidden md:block">
        <Table aria-label={label}>
          <thead>
            <TableRow>
              <TableHead>{t('date')}</TableHead>
              {showEmployee ? <TableHead>{t('employee')}</TableHead> : null}
              <TableHead>{t('status')}</TableHead>
              <TableHead>{t('checkIn')}</TableHead>
              <TableHead>{t('checkOut')}</TableHead>
              <TableHead>{t('worked')}</TableHead>
              <TableHead>{t('notes')}</TableHead>
            </TableRow>
          </thead>
          <tbody>
            {records.map((record) => (
              <TableRow key={record.id} data-testid="attendance-record" data-date={record.workDate}>
                <TableCell>
                  <Link
                    href={`/attendance/records/${record.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {fmt.date(record.workDate)}
                  </Link>
                </TableCell>
                {showEmployee ? (
                  <TableCell>
                    {record.employee.fullName}{' '}
                    <span className="text-muted-foreground">· {record.employee.employeeNumber}</span>
                  </TableCell>
                ) : null}
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={record.status} />
                    {record.mode === null ? null : <Badge>{t(`modes.${record.mode}`)}</Badge>}
                  </span>
                </TableCell>
                <TableCell>{fmt.time(record.checkInAt, record.timeZone)}</TableCell>
                <TableCell>{fmt.time(record.checkOutAt, record.timeZone)}</TableCell>
                <TableCell>{fmt.duration(record.workedMinutes)}</TableCell>
                <TableCell>
                  <RecordFlags record={record} />
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-3 md:hidden" aria-label={label}>
        {records.map((record) => (
          <li key={record.id} data-testid="attendance-record-card" data-date={record.workDate}>
            <Link
              href={`/attendance/records/${record.id}`}
              className="flex min-h-11 flex-col gap-2 rounded-lg border p-4 hover:bg-accent"
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{fmt.date(record.workDate)}</span>
                <StatusBadge status={record.status} />
              </span>
              {showEmployee ? <span className="text-sm">{record.employee.fullName}</span> : null}
              <span className="text-sm text-muted-foreground">
                {t('inOut', {
                  checkIn: fmt.time(record.checkInAt, record.timeZone),
                  checkOut: fmt.time(record.checkOutAt, record.timeZone),
                })}{' '}
                · {fmt.duration(record.workedMinutes)}
              </span>
              <RecordFlags record={record} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- Tabs (WAI-ARIA tabs pattern, RTL-aware arrow keys) ----

export function SectionTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  labelOf,
  children,
}: {
  readonly tabs: readonly T[];
  readonly value: T;
  readonly onChange: (tab: T) => void;
  readonly label: string;
  readonly labelOf: (tab: T) => string;
  readonly children: ReactNode;
}) {
  const buttonsRef = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.indexOf(value);
    const rtl = document.documentElement.dir === 'rtl';
    let next: T | undefined;
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = tabs[(index + 1) % tabs.length];
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs.at(-1);
    if (next !== undefined) {
      event.preventDefault();
      onChange(next);
      buttonsRef.current.get(next)?.focus();
    }
  };
  return (
    <>
      <div className="relative mb-4 overflow-x-auto border-b">
        <div role="tablist" aria-label={label} className="flex min-w-max gap-1" onKeyDown={onKeyDown}>
          {tabs.map((tab) => (
            <button
              key={tab}
              ref={(element) => {
                if (element === null) buttonsRef.current.delete(tab);
                else buttonsRef.current.set(tab, element);
              }}
              type="button"
              role="tab"
              id={`tab-${tab}`}
              aria-selected={value === tab}
              aria-controls={value === tab ? `panel-${tab}` : undefined}
              tabIndex={value === tab ? 0 : -1}
              onClick={() => {
                onChange(tab);
              }}
              className="min-h-11 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground aria-selected:border-primary aria-selected:text-foreground"
            >
              {labelOf(tab)}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`panel-${value}`} aria-labelledby={`tab-${value}`} tabIndex={0}>
        {children}
      </div>
    </>
  );
}

// ---- Today: explicit check-in / check-out ----

type CheckKind = 'CHECK_IN' | 'CHECK_OUT';
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating'; readonly action: CheckKind }
  | { readonly kind: 'lowAccuracy'; readonly action: CheckKind; readonly report: OkReport }
  | { readonly kind: 'problem'; readonly action: CheckKind; readonly problem: LocationProblem };

/** Network failures and server errors may have been recorded: a retry reuses the key and gets the original result. */
function mayHaveBeenRecorded(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 0 || error.status >= 500;
}

export function CheckPanel({ today }: { readonly today: AttendanceToday }) {
  const t = useTranslations('attendance');
  const queryClient = useQueryClient();
  const fmt = useAttendanceFormat();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const attemptRef = useRef<{ action: CheckKind; key: string } | null>(null);

  const check = useMutation({
    mutationFn: ({ action, location }: { action: CheckKind; location: LocationReport | undefined }) => {
      if (attemptRef.current?.action !== action) {
        attemptRef.current = { action, key: crypto.randomUUID() };
      }
      const params = { header: { 'Idempotency-Key': attemptRef.current.key } };
      const body = location === undefined ? {} : { location };
      return request(() =>
        action === 'CHECK_IN'
          ? api.POST('/api/v1/attendance/check-in', { params, body })
          : api.POST('/api/v1/attendance/check-out', { params, body }),
      );
    },
    onSuccess: async (result, { action }) => {
      attemptRef.current = null;
      setPhase({ kind: 'idle' });
      const { event, record } = result.data;
      const time = fmt.time(event.recordedAt, record.timeZone);
      setNotice(
        event.reviewStatus === 'PENDING_REVIEW'
          ? t('recordedForReview', { time })
          : action === 'CHECK_IN'
            ? t('checkedIn', { time })
            : t('checkedOut', { time }),
      );
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
    onError: (error) => {
      if (!mayHaveBeenRecorded(error)) attemptRef.current = null;
      setPhase({ kind: 'idle' });
    },
  });

  const start = async (action: CheckKind) => {
    setNotice(null);
    check.reset();
    if (!today.locationRequired) {
      check.mutate({ action, location: undefined });
      return;
    }
    setPhase({ kind: 'locating', action });
    const acquired = await readLocation();
    if (acquired.kind === 'problem') {
      setPhase({ kind: 'problem', action, problem: acquired.problem });
      return;
    }
    if (today.maxAccuracyMeters !== null && acquired.report.accuracy > today.maxAccuracyMeters) {
      setPhase({ kind: 'lowAccuracy', action, report: acquired.report });
      return;
    }
    check.mutate({ action, location: acquired.report });
  };

  const busy = phase.kind === 'locating' || check.isPending;
  const record = today.record;
  const action = today.nextAction === 'NONE' ? null : today.nextAction;
  const blocked = today.locationRequired && (!today.configured || today.eligibleLocationCount === 0);

  return (
    <Card data-testid="attendance-today" data-next-action={today.nextAction}>
      <CardHeader>
        <CardTitle>{fmt.longDate(today.workDate)}</CardTitle>
        {record === null ? null : <StatusBadge status={record.status} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex flex-col">
            <dt className="text-muted-foreground">{t('shift')}</dt>
            <dd data-testid="attendance-shift">
              {today.shift === null
                ? t('noShift')
                : t('shiftLine', {
                    name: today.shift.name,
                    start: fmt.time(today.scheduledStartAt, today.timeZone),
                    end: fmt.time(today.scheduledEndAt, today.timeZone),
                  })}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted-foreground">{t('plannedMode')}</dt>
            <dd>{today.plannedMode === null ? t('modes.OFFICE') : t(`modes.${today.plannedMode}`)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted-foreground">{t('checkIn')}</dt>
            <dd data-testid="attendance-check-in-time">
              {fmt.time(record?.checkInAt ?? null, today.timeZone)}
              {record?.checkInLocation === null || record === null ? null : ` · ${record.checkInLocation.name}`}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-muted-foreground">{t('checkOut')}</dt>
            <dd data-testid="attendance-check-out-time">
              {fmt.time(record?.checkOutAt ?? null, today.timeZone)}
              {record?.checkOutLocation === null || record === null ? null : ` · ${record.checkOutLocation.name}`}
            </dd>
          </div>
        </dl>
        {record === null ? null : <RecordFlags record={record} />}
        {today.effects.length === 0 ? null : (
          <ul className="flex flex-col gap-1 text-sm" aria-label={t('approvedRequests')}>
            {today.effects.map((effect) => (
              <li key={`${effect.requestId}-${effect.mode}`}>
                <Link href={`/requests/${effect.requestId}`} className="underline underline-offset-4">
                  {effect.fromTime === null || effect.toTime === null
                    ? t(`effects.${effect.mode}`)
                    : t('effectWindow', {
                        mode: t(`effects.${effect.mode}`),
                        from: effect.fromTime,
                        to: effect.toTime,
                      })}
                </Link>
              </li>
            ))}
          </ul>
        )}

        {!today.eligible ? (
          <p role="alert" className="rounded-md border border-warning/40 p-3 text-sm">
            {t(`ineligible.${today.ineligibleReason ?? 'NO_PROFILE'}`)}
          </p>
        ) : blocked ? (
          <p role="alert" className="rounded-md border border-warning/40 p-3 text-sm">
            {today.configured ? t('noLocations') : t('notConfigured')}
          </p>
        ) : action === null ? (
          <p className="text-sm text-muted-foreground" data-testid="attendance-done">
            {record?.status === 'COMPLETE' ? t('dayComplete') : t('nothingToRecord')}
          </p>
        ) : (
          <Button
            className="min-h-14 w-full text-base sm:w-auto sm:self-start"
            disabled={busy}
            data-testid="attendance-action"
            onClick={() => {
              void start(action);
            }}
          >
            {action === 'CHECK_IN' ? <LogInIcon aria-hidden="true" /> : <LogOutIcon aria-hidden="true" />}
            {phase.kind === 'locating'
              ? t('locating')
              : check.isPending
                ? t('recording')
                : action === 'CHECK_IN'
                  ? t('checkInAction')
                  : t('checkOutAction')}
          </Button>
        )}

        <div aria-live="polite" className="flex flex-col gap-3">
          {phase.kind === 'lowAccuracy' ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-warning/40 p-3 text-sm"
              data-testid="attendance-low-accuracy"
            >
              <p>
                {t('lowAccuracy', {
                  accuracy: Math.ceil(phase.report.accuracy),
                  max: today.maxAccuracyMeters ?? 0,
                })}
              </p>
              <p id="attendance-low-accuracy-policy" className="text-muted-foreground">
                {t('lowAccuracyPolicy')}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void start(phase.action);
                  }}
                >
                  {t('tryAgain')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-describedby="attendance-low-accuracy-policy"
                  onClick={() => {
                    setPhase({ kind: 'idle' });
                    check.mutate({ action: phase.action, location: phase.report });
                  }}
                >
                  {t('sendReading')}
                </Button>
              </div>
            </div>
          ) : null}
          {phase.kind === 'problem' ? (
            <div
              role="alert"
              className="flex flex-col gap-2 rounded-md border border-warning/40 p-3 text-sm"
              data-testid="attendance-location-problem"
              data-problem={phase.problem}
            >
              <p>{t(`problems.${phase.problem}`)}</p>
              <div className="flex flex-wrap gap-2">
                {phase.problem === 'INSECURE' || phase.problem === 'UNSUPPORTED' ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void start(phase.action);
                    }}
                  >
                    {t('tryAgain')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setPhase({ kind: 'idle' });
                    check.mutate({ action: phase.action, location: problemReport(phase.problem) });
                  }}
                >
                  {t('continueWithoutLocation')}
                </Button>
              </div>
            </div>
          ) : null}
          <FormError error={check.error} />
          {check.error !== null && mayHaveBeenRecorded(check.error) ? (
            <p className="text-sm text-muted-foreground">{t('safeToRetry')}</p>
          ) : null}
          {notice === null ? null : (
            <p role="status" className="flex items-center gap-2 text-sm text-success" data-testid="attendance-notice">
              <CheckIcon aria-hidden="true" className="size-4" />
              {notice}
            </p>
          )}
        </div>

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {today.locationRequired ? t('privacyNotice') : t('privacyNoticeNoLocation')}
        </p>
      </CardContent>
    </Card>
  );
}

// ---- Corrections ----

const reasonOf = (value: string): AdjustmentReason | undefined => ADJUSTMENT_REASONS.find((reason) => reason === value);

interface TimesDraft {
  readonly reasonCode: string;
  readonly checkIn: string;
  readonly checkOut: string;
  readonly checkOutNextDay: boolean;
}

function timesBody(draft: TimesDraft) {
  return {
    ...(draft.checkIn === '' ? {} : { checkIn: draft.checkIn }),
    ...(draft.checkOut === '' ? {} : { checkOut: draft.checkOut }),
    ...(draft.checkOut === '' || !draft.checkOutNextDay ? {} : { checkOutNextDay: true }),
  };
}

function TimesFields({
  draft,
  onChange,
  errors,
}: {
  readonly draft: TimesDraft;
  readonly onChange: (draft: TimesDraft) => void;
  readonly errors: ReadonlyMap<string, string>;
}) {
  const t = useTranslations('attendance');
  return (
    <>
      <Field label={t('reason')} errorCode={errors.get('reasonCode')}>
        {(control) => (
          <NativeSelect
            {...control}
            required
            value={draft.reasonCode}
            onChange={(event) => {
              onChange({ ...draft, reasonCode: event.target.value });
            }}
          >
            <option value="">{t('chooseReason')}</option>
            {ADJUSTMENT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {t(`reasons.${reason}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('correctedCheckIn')} errorCode={errors.get('checkIn')} optional>
          {(control) => (
            <Input
              {...control}
              type="time"
              value={draft.checkIn}
              onChange={(event) => {
                onChange({ ...draft, checkIn: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label={t('correctedCheckOut')} errorCode={errors.get('checkOut')} optional>
          {(control) => (
            <Input
              {...control}
              type="time"
              value={draft.checkOut}
              onChange={(event) => {
                onChange({ ...draft, checkOut: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.checkOutNextDay}
          onChange={(event) => {
            onChange({ ...draft, checkOutNextDay: event.target.checked });
          }}
        />
        {t('checkOutNextDay')}
      </label>
    </>
  );
}

/** An employee's correction request: becomes a Phase 6 request routed for approval; evidence is never edited. */
export function CorrectionDialog({ today, defaultDate }: { readonly today: string; readonly defaultDate?: string }) {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [workDate, setWorkDate] = useState(defaultDate ?? today);
  const [times, setTimes] = useState<TimesDraft>({ reasonCode: '', checkIn: '', checkOut: '', checkOutNextDay: false });
  const [details, setDetails] = useState('');
  const [done, setDone] = useState<number | null>(null);
  const keyRef = useRef<string>('');
  const save = useMutation({
    mutationFn: () => {
      const reasonCode = reasonOf(times.reasonCode) ?? 'INCORRECT_TIME';
      return request(() =>
        api.POST('/api/v1/attendance/corrections', {
          params: { header: { 'Idempotency-Key': keyRef.current } },
          body: { workDate, reasonCode, details: details.trim(), ...timesBody(times) },
        }),
      );
    },
    onSuccess: async (result) => {
      setOpen(false);
      setDone(result.data.request.number);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
        queryClient.invalidateQueries({ queryKey: requestKeys.all }),
      ]);
    },
  });
  const errors = fieldErrorsOf(save.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  const ready =
    reasonOf(times.reasonCode) !== undefined &&
    (times.checkIn !== '' || times.checkOut !== '') &&
    details.trim() !== '';
  return (
    <div className="flex flex-col gap-2">
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (next) {
            keyRef.current = crypto.randomUUID();
            save.reset();
            setDone(null);
          }
          setOpen(next);
        }}
      >
        <Button
          variant="outline"
          data-testid="attendance-request-correction"
          onClick={() => {
            keyRef.current = crypto.randomUUID();
            save.reset();
            setDone(null);
            setOpen(true);
          }}
        >
          {t('requestCorrection')}
        </Button>
        <DialogContent title={t('requestCorrection')} description={t('correctionHint')} closeLabel={common('close')}>
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <FormError error={save.error} />
            <Field label={t('workDate')} errorCode={errors.get('workDate')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  required
                  min={shiftDate(today, -ATTENDANCE_LIMITS.correctionDaysBack)}
                  max={today}
                  value={workDate}
                  onChange={(event) => {
                    setWorkDate(event.target.value);
                  }}
                />
              )}
            </Field>
            <TimesFields draft={times} onChange={setTimes} errors={errors} />
            <Field label={t('details')} errorCode={errors.get('details')}>
              {(control) => (
                <Textarea
                  {...control}
                  required
                  rows={3}
                  maxLength={2000}
                  value={details}
                  onChange={(event) => {
                    setDetails(event.target.value);
                  }}
                />
              )}
            </Field>
            <Button type="submit" className="self-end" disabled={save.isPending || !ready}>
              {save.isPending ? common('saving') : t('submitCorrection')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {done === null ? null : <StatusMessage>{t('correctionSubmitted', { number: done })}</StatusMessage>}
    </div>
  );
}

export interface CorrectionTarget {
  readonly profileId: string;
  readonly workDate: string;
  readonly employeeName: string;
  /** Current record version; null when the day has no record yet. */
  readonly version: number | null;
}

/** Privileged direct correction (`attendance.admin`; the API requires fresh MFA). Always with a reason and a note. */
export function AdminCorrectionDialog({ target }: { readonly target: CorrectionTarget }) {
  const t = useTranslations('attendance');
  const common = useTranslations('common');
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [times, setTimes] = useState<TimesDraft>({ reasonCode: '', checkIn: '', checkOut: '', checkOutNextDay: false });
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/attendance/admin/corrections', {
          body: {
            profileId: target.profileId,
            workDate: target.workDate,
            reasonCode: reasonOf(times.reasonCode) ?? 'INCORRECT_TIME',
            note: note.trim(),
            version: target.version,
            ...timesBody(times),
          },
        }),
      ),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const ready =
    reasonOf(times.reasonCode) !== undefined && (times.checkIn !== '' || times.checkOut !== '') && note.trim() !== '';
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        data-testid="attendance-admin-correct"
        onClick={() => {
          save.reset();
          setOpen(true);
        }}
      >
        {t('correct')}
        <span className="sr-only">
          {target.employeeName} {target.workDate}
        </span>
      </Button>
      <DialogContent
        title={t('adminCorrectTitle', { name: target.employeeName })}
        description={t('adminCorrectHint')}
        closeLabel={common('close')}
      >
        <form
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            save.mutate();
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <FormError error={save.error} />
          <TimesFields draft={times} onChange={setTimes} errors={errors} />
          <Field label={t('note')} errorCode={errors.get('note')}>
            {(control) => (
              <Textarea
                {...control}
                required
                rows={3}
                maxLength={1000}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" className="self-end" disabled={save.isPending || !ready}>
            {save.isPending ? common('saving') : t('applyCorrection')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Review of flagged evidence ----

export function ReviewActions({ event }: { readonly event: AttendanceEvent }) {
  const t = useTranslations('attendance');
  const queryClient = useQueryClient();
  const message = useErrorMessage();
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'ACCEPTED' | 'REJECTED') =>
      request(() =>
        api.POST('/api/v1/attendance/events/{id}/review', {
          params: { path: { id: event.id } },
          body: { decision, ...(note.trim() === '' ? {} : { note: note.trim() }) },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
  return (
    <div className="flex flex-col gap-2" data-testid="attendance-review-actions">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t('reviewNote')}</span>
        <Input
          maxLength={1000}
          value={note}
          onChange={(change) => {
            setNote(change.target.value);
          }}
        />
        <span className="text-xs text-muted-foreground">{t('reviewNoteHint')}</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={decide.isPending}
          onClick={() => {
            decide.mutate('ACCEPTED');
          }}
        >
          {t('accept')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={decide.isPending || note.trim() === ''}
          onClick={() => {
            decide.mutate('REJECTED');
          }}
        >
          {t('reject')}
        </Button>
      </div>
      {decide.error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {message(decide.error)}
        </p>
      )}
    </div>
  );
}

/** One evidence event: what was recorded, by whom, and how the location check came out (never coordinates). */
export function EventItem({
  event,
  timeZone,
  children,
}: {
  readonly event: AttendanceEvent;
  readonly timeZone: string;
  readonly children?: ReactNode;
}) {
  const t = useTranslations('attendance');
  const fmt = useAttendanceFormat();
  return (
    <li
      className="flex flex-col gap-1 rounded-md border p-3 text-sm"
      data-testid="attendance-event"
      data-kind={event.kind}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{t(`eventKinds.${event.kind}`)}</span>
        <time dateTime={event.recordedAt} className="text-muted-foreground">
          {fmt.dateTime(event.recordedAt, timeZone)}
        </time>
      </span>
      {event.location === null && event.geofenceResult === null ? null : (
        <span className="flex flex-wrap items-center gap-2">
          <MapPinIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          {event.location?.name ?? t('noMatchedLocation')}
          {event.geofenceResult === null ? null : <Badge>{t(`geofence.${event.geofenceResult}`)}</Badge>}
          {event.distanceMeters === null ? null : (
            <span className="text-muted-foreground">{t('distance', { meters: event.distanceMeters })}</span>
          )}
          {event.accuracyMeters === null ? null : (
            <span className="text-muted-foreground">{t('accuracy', { meters: event.accuracyMeters })}</span>
          )}
        </span>
      )}
      {event.adjustedCheckInAt === null && event.adjustedCheckOutAt === null ? null : (
        <span>
          {t('adjustedTimes', {
            checkIn: event.adjustedCheckInAt === null ? '—' : fmt.time(event.adjustedCheckInAt, timeZone),
            checkOut: event.adjustedCheckOutAt === null ? '—' : fmt.time(event.adjustedCheckOutAt, timeZone),
          })}
        </span>
      )}
      {event.reasonCode === null ? null : <span>{t(`reasons.${event.reasonCode}`)}</span>}
      {event.note === null ? null : <span className="whitespace-pre-wrap">{event.note}</span>}
      {event.actor === null ? null : (
        <span className="text-muted-foreground">{t('by', { name: event.actor.name })}</span>
      )}
      {event.reviewStatus === 'NOT_REQUIRED' ? null : (
        <span className="flex flex-wrap items-center gap-2">
          <Badge
            tone={
              event.reviewStatus === 'REJECTED' ? 'danger' : event.reviewStatus === 'ACCEPTED' ? 'success' : 'warning'
            }
          >
            {t(`reviewStatuses.${event.reviewStatus}`)}
          </Badge>
          {event.reviewedBy === null ? null : (
            <span className="text-muted-foreground">{t('by', { name: event.reviewedBy.name })}</span>
          )}
          {event.reviewNote === null ? null : <span>{event.reviewNote}</span>}
        </span>
      )}
      {event.device === null ? null : (
        <span className="text-xs break-all text-muted-foreground">
          {t('device', { ip: event.device.ipAddress ?? '—', agent: event.device.userAgent ?? '—' })}
        </span>
      )}
      {children}
    </li>
  );
}
