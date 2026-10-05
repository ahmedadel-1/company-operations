'use client';

import { useTranslations } from 'next-intl';

import {
  AttendanceTodayView,
  DashboardError,
  Freshness,
  SectionCard,
  SectionSkeleton,
  TrendCard,
  useDashboardAccess,
} from '../../../../components/dashboard';
import { Forbidden, PageHeader } from '../../../../components/states';
import { useTeamDashboard } from '../../../../lib/dashboard';

/**
 * Team, department and HR view of today's attendance in the caller's `attendance.team` scope. Counts
 * only (no locations, no per-person rankings); each number opens the filtered team-day list.
 */
export default function TeamDashboardPage() {
  const t = useTranslations('dashboard');
  const access = useDashboardAccess();
  const dashboard = useTeamDashboard(access.team);
  if (!access.team) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('team.pageTitle')}
        description={t('team.description')}
        actions={
          dashboard.data === undefined ? undefined : (
            <Freshness
              generatedAt={dashboard.data.generatedAt}
              onRefresh={() => {
                void dashboard.refetch();
              }}
            />
          )
        }
      />
      <div className="flex flex-col gap-4" data-testid="team-dashboard">
        <SectionCard title={t('attendance.title')}>
          {dashboard.isPending ? (
            <SectionSkeleton />
          ) : dashboard.isError ? (
            <DashboardError
              error={dashboard.error}
              onRetry={() => {
                void dashboard.refetch();
              }}
            />
          ) : (
            <AttendanceTodayView section={dashboard.data.attendance} />
          )}
        </SectionCard>
        <TrendCard metric="attendance_presence" title={t('team.trend')} />
      </div>
    </>
  );
}
