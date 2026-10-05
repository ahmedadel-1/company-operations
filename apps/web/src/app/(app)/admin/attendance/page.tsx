'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { useAttendanceFormat } from '../../../../components/attendance';
import { EmployeePicker } from '../../../../components/employee-picker';
import type { PickedEmployee } from '../../../../components/employee-picker';
import { Field, fieldErrorsOf, FormError, StatusMessage } from '../../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import {
  ACCURACY_ACTIONS,
  attendanceKeys,
  useAttendancePolicy,
  useAttendanceToday,
  useShiftAssignments,
  useShifts,
  WEEKDAYS,
} from '../../../../lib/attendance';
import type { AccuracyAction, AttendancePolicy, Shift, ShiftAssignment } from '../../../../lib/attendance';
import { useCanOrgWide } from '../../../../lib/session';

/** Attendance configuration: accuracy policy (`org.settings.manage`, fresh MFA) and shifts (`attendance.config`). */
export default function AttendanceAdminPage() {
  const t = useTranslations('attendanceAdmin');
  const orgWide = useCanOrgWide();
  const config = orgWide('attendance.config');
  const settings = orgWide('org.settings.manage');
  if (!config && !settings) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-6">
        <PolicyCard editable={settings} />
        {config ? <ShiftsCard /> : null}
        {config ? <AssignmentsCard /> : null}
      </div>
    </>
  );
}

const actionOf = (value: string): AccuracyAction =>
  ACCURACY_ACTIONS.find((item) => item === value) ?? 'FLAG_FOR_REVIEW';

function PolicyCard({ editable }: { readonly editable: boolean }) {
  const t = useTranslations('attendanceAdmin');
  const policy = useAttendancePolicy();
  const [savedVersion, setSavedVersion] = useState<number | null>(null);
  return (
    <Card data-testid="attendance-policy">
      <CardHeader>
        <CardTitle>{t('policyTitle')}</CardTitle>
        {policy.data?.configured === false ? <Badge tone="warning">{t('notConfigured')}</Badge> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{t('policyDescription')}</p>
        {policy.isPending ? (
          <ListSkeleton rows={2} />
        ) : policy.isError ? (
          <ErrorState error={policy.error} />
        ) : (
          <PolicyForm
            key={policy.data.version ?? 0}
            policy={policy.data}
            editable={editable}
            saved={savedVersion !== null && savedVersion === policy.data.version}
            onSaved={setSavedVersion}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Keyed by the policy version, so the saved confirmation lives in the parent and survives the remount. */
function PolicyForm({
  policy,
  editable,
  saved,
  onSaved,
}: {
  readonly policy: AttendancePolicy;
  readonly editable: boolean;
  readonly saved: boolean;
  readonly onSaved: (version: number | null) => void;
}) {
  const t = useTranslations('attendanceAdmin');
  const common = useTranslations('common');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    maxAccuracyMeters: String(policy.maxAccuracyMeters ?? 100),
    lowAccuracyAction: policy.lowAccuracyAction ?? 'FLAG_FOR_REVIEW',
    missingLocationAction: policy.missingLocationAction ?? 'REJECT',
    missingCheckoutAfterMinutes: String(policy.missingCheckoutAfterMinutes ?? 240),
  });
  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.PUT('/api/v1/attendance/policy', {
          body: {
            maxAccuracyMeters: Number(draft.maxAccuracyMeters),
            lowAccuracyAction: draft.lowAccuracyAction,
            missingLocationAction: draft.missingLocationAction,
            missingCheckoutAfterMinutes: Number(draft.missingCheckoutAfterMinutes),
            version: policy.version,
          },
        }),
      ),
    onSuccess: async (result) => {
      queryClient.setQueryData(attendanceKeys.policy, result.data);
      onSaved(result.data.version);
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.today });
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <form
      noValidate
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        onSaved(null);
        save.mutate();
      }}
    >
      <div className="sm:col-span-2">
        <FormError error={save.error} />
      </div>
      <Field label={t('maxAccuracy')} hint={t('maxAccuracyHint')} errorCode={errors.get('maxAccuracyMeters')}>
        {(control) => (
          <Input
            {...control}
            type="number"
            min={10}
            max={5000}
            disabled={!editable}
            value={draft.maxAccuracyMeters}
            onChange={(event) => {
              setDraft({ ...draft, maxAccuracyMeters: event.target.value });
            }}
          />
        )}
      </Field>
      <Field
        label={t('missingCheckoutAfter')}
        hint={t('missingCheckoutAfterHint')}
        errorCode={errors.get('missingCheckoutAfterMinutes')}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            min={30}
            max={1440}
            disabled={!editable}
            value={draft.missingCheckoutAfterMinutes}
            onChange={(event) => {
              setDraft({ ...draft, missingCheckoutAfterMinutes: event.target.value });
            }}
          />
        )}
      </Field>
      <Field
        label={t('lowAccuracyAction')}
        hint={t('lowAccuracyActionHint')}
        errorCode={errors.get('lowAccuracyAction')}
      >
        {(control) => (
          <NativeSelect
            {...control}
            disabled={!editable}
            value={draft.lowAccuracyAction}
            onChange={(event) => {
              setDraft({ ...draft, lowAccuracyAction: actionOf(event.target.value) });
            }}
          >
            {ACCURACY_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`actions.${value}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field
        label={t('missingLocationAction')}
        hint={t('missingLocationActionHint')}
        errorCode={errors.get('missingLocationAction')}
      >
        {(control) => (
          <NativeSelect
            {...control}
            disabled={!editable}
            value={draft.missingLocationAction}
            onChange={(event) => {
              setDraft({ ...draft, missingLocationAction: actionOf(event.target.value) });
            }}
          >
            {ACCURACY_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`actions.${value}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {editable ? (
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? common('saving') : common('save')}
          </Button>
          {saved ? <StatusMessage>{t('policySaved')}</StatusMessage> : null}
        </div>
      ) : (
        <p className="text-muted-foreground sm:col-span-2">{t('policyReadOnly')}</p>
      )}
    </form>
  );
}

function ShiftsCard() {
  const t = useTranslations('attendanceAdmin');
  const fmtWeekday = useWeekdayName();
  const [includeInactive, setIncludeInactive] = useState(false);
  const shifts = useShifts(includeInactive);
  return (
    <Card data-testid="attendance-shifts">
      <CardHeader>
        <CardTitle>{t('shiftsTitle')}</CardTitle>
        <ShiftDialog />
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{t('shiftsDescription')}</p>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => {
              setIncludeInactive(event.target.checked);
            }}
          />
          {t('showInactive')}
        </label>
        {shifts.isPending ? (
          <ListSkeleton rows={2} />
        ) : shifts.isError ? (
          <ErrorState error={shifts.error} />
        ) : shifts.data.length === 0 ? (
          <EmptyState message={t('shiftsEmpty')} />
        ) : (
          <ul className="flex flex-col gap-3" aria-label={t('shiftsTitle')}>
            {shifts.data.map((shift) => (
              <li
                key={shift.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                data-testid="attendance-shift"
                data-name={shift.name}
              >
                <span className="flex flex-col gap-1">
                  <span className="font-medium">
                    {shift.name} {shift.active ? null : <Badge>{t('inactive')}</Badge>}
                    {shift.crossesMidnight ? <Badge className="ms-1">{t('overnight')}</Badge> : null}
                  </span>
                  <span className="text-muted-foreground" dir="ltr">
                    {shift.start}–{shift.end}
                  </span>
                  <span className="text-muted-foreground">
                    {shift.weekdays.map((day) => fmtWeekday(day)).join(' · ')} ·{' '}
                    {t('graceLine', { late: shift.lateGraceMinutes, early: shift.earlyLeaveGraceMinutes })} ·{' '}
                    {t('assignedCount', { count: shift.activeAssignments })}
                  </span>
                </span>
                <ShiftDialog shift={shift} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Localized weekday name for an ISO weekday (1 = Monday). */
function useWeekdayName(): (day: number) => string {
  const t = useTranslations('attendanceAdmin.weekdays');
  return (day) => t(String(day) as '1');
}

function ShiftDialog({ shift }: { readonly shift?: Shift }) {
  const t = useTranslations('attendanceAdmin');
  const common = useTranslations('common');
  const weekday = useWeekdayName();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const initial = () => ({
    name: shift?.name ?? '',
    start: shift?.start ?? '09:00',
    end: shift?.end ?? '17:00',
    lateGraceMinutes: String(shift?.lateGraceMinutes ?? 15),
    earlyLeaveGraceMinutes: String(shift?.earlyLeaveGraceMinutes ?? 0),
    weekdays: shift === undefined ? [1, 2, 3, 4, 5] : [...shift.weekdays],
    active: shift?.active ?? true,
  });
  const [draft, setDraft] = useState(initial);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: draft.name.trim(),
        start: draft.start,
        end: draft.end,
        lateGraceMinutes: Number(draft.lateGraceMinutes),
        earlyLeaveGraceMinutes: Number(draft.earlyLeaveGraceMinutes),
        weekdays: [...draft.weekdays].sort((left, right) => left - right),
        active: draft.active,
      };
      return shift === undefined
        ? request(() => api.POST('/api/v1/attendance/shifts', { body }))
        : request(() =>
            api.PATCH('/api/v1/attendance/shifts/{id}', {
              params: { path: { id: shift.id } },
              body: { ...body, version: shift.version },
            }),
          );
    },
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const title = shift === undefined ? t('newShift') : t('editShift');
  const overnight = draft.end < draft.start;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={shift === undefined ? 'default' : 'outline'}
        size={shift === undefined ? 'default' : 'sm'}
        onClick={() => {
          setDraft(initial());
          save.reset();
          setOpen(true);
        }}
      >
        {shift === undefined ? <PlusIcon aria-hidden="true" /> : null}
        {shift === undefined ? title : common('edit')}
        {shift === undefined ? null : <span className="sr-only">{shift.name}</span>}
      </Button>
      <DialogContent title={title} closeLabel={common('close')}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <FormError error={save.error} />
          <Field label={t('shiftName')} errorCode={errors.get('name')}>
            {(control) => (
              <Input
                {...control}
                required
                maxLength={120}
                value={draft.name}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('start')} errorCode={errors.get('start')}>
              {(control) => (
                <Input
                  {...control}
                  type="time"
                  required
                  value={draft.start}
                  onChange={(event) => {
                    setDraft({ ...draft, start: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('end')} hint={overnight ? t('overnightHint') : undefined} errorCode={errors.get('end')}>
              {(control) => (
                <Input
                  {...control}
                  type="time"
                  required
                  value={draft.end}
                  onChange={(event) => {
                    setDraft({ ...draft, end: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('lateGrace')} errorCode={errors.get('lateGraceMinutes')}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={0}
                  max={240}
                  value={draft.lateGraceMinutes}
                  onChange={(event) => {
                    setDraft({ ...draft, lateGraceMinutes: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('earlyGrace')} errorCode={errors.get('earlyLeaveGraceMinutes')}>
              {(control) => (
                <Input
                  {...control}
                  type="number"
                  min={0}
                  max={240}
                  value={draft.earlyLeaveGraceMinutes}
                  onChange={(event) => {
                    setDraft({ ...draft, earlyLeaveGraceMinutes: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-sm font-medium">{t('weekdaysLabel')}</legend>
            <div className="flex flex-wrap gap-x-4">
              {WEEKDAYS.map((day) => (
                <label key={day} className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={draft.weekdays.includes(day)}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        weekdays: event.target.checked
                          ? [...draft.weekdays, day]
                          : draft.weekdays.filter((value) => value !== day),
                      });
                    }}
                  />
                  {weekday(day)}
                </label>
              ))}
            </div>
            {errors.get('weekdays') === undefined ? null : (
              <p className="text-sm text-destructive">{t('weekdaysError')}</p>
            )}
          </fieldset>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.active}
              onChange={(event) => {
                setDraft({ ...draft, active: event.target.checked });
              }}
            />
            {t('active')}
          </label>
          <Button
            type="submit"
            className="self-end"
            disabled={save.isPending || draft.name.trim() === '' || draft.weekdays.length === 0}
          >
            {save.isPending ? common('saving') : common('save')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignmentsCard() {
  const t = useTranslations('attendanceAdmin');
  const common = useTranslations('common');
  const fmt = useAttendanceFormat();
  const [shiftId, setShiftId] = useState('');
  const shifts = useShifts(false);
  const assignments = useShiftAssignments(shiftId);
  const rows = assignments.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <Card data-testid="attendance-assignments">
      <CardHeader>
        <CardTitle>{t('assignmentsTitle')}</CardTitle>
        <AssignmentDialog shifts={shifts.data ?? []} />
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">{t('assignmentsDescription')}</p>
        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor="assignments-shift">{t('shift')}</Label>
          <NativeSelect
            id="assignments-shift"
            value={shiftId}
            onChange={(event) => {
              setShiftId(event.target.value);
            }}
          >
            <option value="">{common('all')}</option>
            {(shifts.data ?? []).map((shift) => (
              <option key={shift.id} value={shift.id}>
                {shift.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        {assignments.isPending ? (
          <ListSkeleton rows={3} />
        ) : assignments.isError ? (
          <ErrorState error={assignments.error} />
        ) : rows.length === 0 ? (
          <EmptyState message={t('assignmentsEmpty')} />
        ) : (
          <ul className="flex flex-col gap-3" aria-label={t('assignmentsTitle')}>
            {rows.map((assignment) => (
              <li
                key={assignment.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                data-testid="attendance-assignment"
              >
                <span className="flex flex-col gap-1">
                  <span className="font-medium">
                    {assignment.employee.fullName}{' '}
                    <span className="text-muted-foreground">· {assignment.employee.employeeNumber}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {assignment.shift.name} ·{' '}
                    {assignment.effectiveTo === null
                      ? t('fromDate', { date: fmt.date(assignment.effectiveFrom) })
                      : t('dateRange', {
                          from: fmt.date(assignment.effectiveFrom),
                          to: fmt.date(assignment.effectiveTo),
                        })}
                  </span>
                </span>
                {assignment.effectiveTo === null ? <EndAssignmentDialog assignment={assignment} /> : null}
              </li>
            ))}
          </ul>
        )}
        {assignments.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={assignments.isFetchingNextPage}
            onClick={() => {
              void assignments.fetchNextPage();
            }}
          >
            {assignments.isFetchingNextPage ? common('loading') : common('loadMore')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AssignmentDialog({ shifts }: { readonly shifts: readonly Shift[] }) {
  const t = useTranslations('attendanceAdmin');
  const common = useTranslations('common');
  const queryClient = useQueryClient();
  const today = useAttendanceToday().data?.workDate ?? '';
  const [open, setOpen] = useState(false);
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [draft, setDraft] = useState({ shiftId: '', effectiveFrom: '', effectiveTo: '' });
  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/attendance/shift-assignments', {
          body: {
            profileId: employee?.id ?? '',
            shiftId: draft.shiftId,
            effectiveFrom: draft.effectiveFrom,
            ...(draft.effectiveTo === '' ? {} : { effectiveTo: draft.effectiveTo }),
          },
        }),
      ),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        disabled={shifts.length === 0}
        onClick={() => {
          setEmployee(null);
          setDraft({ shiftId: shifts[0]?.id ?? '', effectiveFrom: today, effectiveTo: '' });
          save.reset();
          setOpen(true);
        }}
      >
        <PlusIcon aria-hidden="true" />
        {t('assign')}
      </Button>
      <DialogContent title={t('assign')} description={t('assignHint')} closeLabel={common('close')}>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <FormError error={save.error} />
          <EmployeePicker label={t('employee')} value={employee} onChange={setEmployee} />
          <Field label={t('shift')} errorCode={errors.get('shiftId')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={draft.shiftId}
                onChange={(event) => {
                  setDraft({ ...draft, shiftId: event.target.value });
                }}
              >
                {shifts.map((shift) => (
                  <option key={shift.id} value={shift.id}>
                    {shift.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('effectiveFrom')} errorCode={errors.get('effectiveFrom')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  required
                  min={today}
                  value={draft.effectiveFrom}
                  onChange={(event) => {
                    setDraft({ ...draft, effectiveFrom: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('effectiveTo')} errorCode={errors.get('effectiveTo')} optional>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  min={draft.effectiveFrom}
                  value={draft.effectiveTo}
                  onChange={(event) => {
                    setDraft({ ...draft, effectiveTo: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>
          <Button
            type="submit"
            className="self-end"
            disabled={save.isPending || employee === null || draft.shiftId === '' || draft.effectiveFrom === ''}
          >
            {save.isPending ? common('saving') : t('assign')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EndAssignmentDialog({ assignment }: { readonly assignment: ShiftAssignment }) {
  const t = useTranslations('attendanceAdmin');
  const common = useTranslations('common');
  const queryClient = useQueryClient();
  const today = useAttendanceToday().data?.workDate ?? '';
  const [open, setOpen] = useState(false);
  const [effectiveTo, setEffectiveTo] = useState('');
  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/attendance/shift-assignments/{id}/end', {
          params: { path: { id: assignment.id } },
          body: { effectiveTo, version: assignment.version },
        }),
      ),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setEffectiveTo(today);
          save.reset();
          setOpen(true);
        }}
      >
        {t('endAssignment')}
        <span className="sr-only">{assignment.employee.fullName}</span>
      </Button>
      <DialogContent
        title={t('endAssignmentTitle', { name: assignment.employee.fullName })}
        description={t('endAssignmentHint')}
        closeLabel={common('close')}
      >
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <FormError error={save.error} />
          <Field label={t('lastDay')} errorCode={errors.get('effectiveTo')}>
            {(control) => (
              <Input
                {...control}
                type="date"
                required
                min={assignment.effectiveFrom}
                value={effectiveTo}
                onChange={(event) => {
                  setEffectiveTo(event.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" className="self-end" disabled={save.isPending || effectiveTo === ''}>
            {save.isPending ? common('saving') : t('endAssignment')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
