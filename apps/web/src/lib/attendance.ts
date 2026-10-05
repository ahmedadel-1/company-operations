import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { paths } from '@company-ops/api-client';

import { api, request } from './api';

type Data<P extends keyof paths> = paths[P] extends {
  get: { responses: { 200: { content: { 'application/json': { data: infer D } } } } };
}
  ? D
  : never;
type Item<P extends keyof paths> = Data<P> extends readonly (infer I)[] ? I : never;
type Query<P extends keyof paths> = paths[P]['get'] extends { parameters: { query?: infer Q } }
  ? NonNullable<Q>
  : never;

export type AttendanceToday = Data<'/api/v1/attendance/today'>;
export type AttendanceRecord = Item<'/api/v1/attendance/me/records'>;
export type AttendanceRecordDetail = Data<'/api/v1/attendance/records/{id}'>;
export type AttendanceEvent = AttendanceRecordDetail['events'][number];
export type TeamDayRow = Item<'/api/v1/attendance/team/day'>;
export type ReviewItem = Item<'/api/v1/attendance/reviews'>;
export type AttendanceCorrection = Item<'/api/v1/attendance/corrections'>;
export type AttendancePolicy = Data<'/api/v1/attendance/policy'>;
export type Shift = Item<'/api/v1/attendance/shifts'>;
export type ShiftAssignment = Item<'/api/v1/attendance/shift-assignments'>;
export type RecordStatus = AttendanceRecord['status'];
export type DayStatus = TeamDayRow['status'];
export type AttendanceMode = NonNullable<AttendanceRecord['mode']>;
export type AdjustmentReason = AttendanceCorrection['reasonCode'];
export type AccuracyAction = NonNullable<AttendancePolicy['lowAccuracyAction']>;
export type TeamRecordQuery = Omit<Query<'/api/v1/attendance/records'>, 'cursor' | 'limit'>;
type TeamDayQuery = Query<'/api/v1/attendance/team/day'>;
export type LocationReport = NonNullable<
  NonNullable<paths['/api/v1/attendance/check-in']['post']['requestBody']>['content']['application/json']['location']
>;

export const RECORD_STATUSES = [
  'OPEN',
  'COMPLETE',
  'MISSING_CHECKOUT',
  'EXCUSED',
  'ABSENT',
  'SCHEDULED',
] as const satisfies readonly RecordStatus[];
export const ADJUSTMENT_REASONS = [
  'FORGOT_CHECK_IN',
  'FORGOT_CHECK_OUT',
  'WRONG_LOCATION',
  'SYSTEM_ISSUE',
  'INCORRECT_TIME',
] as const satisfies readonly AdjustmentReason[];
export const ACCURACY_ACTIONS = ['FLAG_FOR_REVIEW', 'REJECT'] as const satisfies readonly AccuracyAction[];
/** ISO weekdays, Monday = 1. */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** Mirrors the server limits (ADR-0022); the server re-checks every value. */
export const ATTENDANCE_LIMITS = { maxExportDays: 62, correctionDaysBack: 31 } as const;

const PAGE_SIZE = 25;

export const attendanceKeys = {
  all: ['attendance'] as const,
  today: ['attendance', 'today'] as const,
  mine: ['attendance', 'mine'] as const,
  corrections: ['attendance', 'corrections'] as const,
  records: (filters: TeamRecordQuery) => ['attendance', 'records', filters] as const,
  teamDay: (date: string, departmentId: string, bucket: string) =>
    ['attendance', 'team-day', date, departmentId, bucket] as const,
  reviews: ['attendance', 'reviews'] as const,
  detail: (id: string) => ['attendance', 'detail', id] as const,
  policy: ['attendance', 'policy'] as const,
  shifts: (includeInactive: boolean) => ['attendance', 'shifts', includeInactive] as const,
  assignments: (shiftId: string) => ['attendance', 'assignments', shiftId] as const,
};

const cursorQuery = (pageParam: string | undefined) => ({
  limit: PAGE_SIZE,
  ...(pageParam === undefined ? {} : { cursor: pageParam }),
});

export function useAttendanceToday(enabled = true) {
  return useQuery({
    queryKey: attendanceKeys.today,
    queryFn: async () => (await request(() => api.GET('/api/v1/attendance/today'))).data,
    enabled,
    // The server decides the work day; refresh occasionally so a screen left open does not go stale.
    refetchInterval: 5 * 60_000,
  });
}

export function useMyAttendance(enabled = true) {
  return useInfiniteQuery({
    queryKey: attendanceKeys.mine,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() => api.GET('/api/v1/attendance/me/records', { params: { query: cursorQuery(pageParam) } })),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

export function useMyCorrections(enabled = true) {
  return useInfiniteQuery({
    queryKey: attendanceKeys.corrections,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() => api.GET('/api/v1/attendance/corrections', { params: { query: cursorQuery(pageParam) } })),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

export function useTeamRecords(filters: TeamRecordQuery, enabled = true) {
  return useInfiniteQuery({
    queryKey: attendanceKeys.records(filters),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/attendance/records', { params: { query: { ...filters, ...cursorQuery(pageParam) } } }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export type DayBucket = NonNullable<TeamDayQuery['bucket']>;

/** Dashboard day buckets (a row can be in several: present and late, for example). */
export const DAY_BUCKETS = [
  'PRESENT',
  'REMOTE',
  'ON_LEAVE',
  'ON_MISSION',
  'LATE',
  'NOT_CHECKED_IN',
  'MISSING_CHECKOUT',
] as const satisfies readonly DayBucket[];

export function useTeamDay(date: string, departmentId: string, bucket: DayBucket | '' = '', enabled = true) {
  return useInfiniteQuery({
    queryKey: attendanceKeys.teamDay(date, departmentId, bucket),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/attendance/team/day', {
          params: {
            query: {
              ...(date === '' ? {} : { date }),
              ...(departmentId === '' ? {} : { departmentId }),
              ...(bucket === '' ? {} : { bucket }),
              ...cursorQuery(pageParam),
            },
          },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    enabled,
  });
}

export function useAttendanceReviews(enabled = true) {
  return useInfiniteQuery({
    queryKey: attendanceKeys.reviews,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() => api.GET('/api/v1/attendance/reviews', { params: { query: cursorQuery(pageParam) } })),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

export function useAttendanceRecord(id: string) {
  return useQuery({
    queryKey: attendanceKeys.detail(id),
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/attendance/records/{id}', { params: { path: { id } } }))).data,
  });
}

export function useAttendancePolicy(enabled = true) {
  return useQuery({
    queryKey: attendanceKeys.policy,
    queryFn: async () => (await request(() => api.GET('/api/v1/attendance/policy'))).data,
    enabled,
  });
}

export function useShifts(includeInactive: boolean, enabled = true) {
  return useQuery({
    queryKey: attendanceKeys.shifts(includeInactive),
    queryFn: async () =>
      (
        await request(() =>
          api.GET('/api/v1/attendance/shifts', {
            params: { query: includeInactive ? { includeInactive: 'true' } : {} },
          }),
        )
      ).data,
    enabled,
  });
}

export function useShiftAssignments(shiftId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: attendanceKeys.assignments(shiftId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request(() =>
        api.GET('/api/v1/attendance/shift-assignments', {
          params: { query: { ...(shiftId === '' ? {} : { shiftId }), ...cursorQuery(pageParam) } },
        }),
      ),
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
    enabled,
  });
}

/** Same-origin CSV download URL (the browser sends the session cookie; the API authorizes the scope). */
export function exportUrl(filters: {
  readonly from: string;
  readonly to: string;
  readonly status?: readonly RecordStatus[];
  readonly departmentId?: string;
}): string {
  const query = new URLSearchParams({ from: filters.from, to: filters.to });
  if (filters.status !== undefined && filters.status.length > 0) query.set('status', filters.status.join(','));
  if (filters.departmentId !== undefined && filters.departmentId !== '')
    query.set('departmentId', filters.departmentId);
  return `/api/v1/attendance/export?${query.toString()}`;
}

/** Calendar arithmetic on `YYYY-MM-DD` strings (no time zone involved). */
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
