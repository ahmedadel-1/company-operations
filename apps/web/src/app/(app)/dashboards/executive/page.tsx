'use client';

import { useTranslations } from 'next-intl';

import { CommercialSectionView } from '../../../../components/commercial-dashboard';
import {
  AttendanceTodayView,
  DashboardError,
  DevelopmentSectionView,
  Freshness,
  NeedsAttentionCard,
  ProjectsSectionView,
  SectionCard,
  SectionSkeleton,
  SupportSectionView,
  TrendCard,
  useDashboardAccess,
} from '../../../../components/dashboard';
import { Forbidden, PageHeader } from '../../../../components/states';
import { useExecutiveDashboard } from '../../../../lib/dashboard';

/**
 * Organization overview for the general manager: today's attendance, project health, support and
 * development signals. Each section appears only when the caller holds its permission.
 */
export default function ExecutiveDashboardPage() {
  const t = useTranslations('dashboard');
  const access = useDashboardAccess();
  const dashboard = useExecutiveDashboard(access.executive);
  if (!access.executive) {
    return <Forbidden />;
  }
  const data = dashboard.data;
  return (
    <>
      <PageHeader
        title={t('executive.pageTitle')}
        description={t('executive.description')}
        actions={
          data === undefined ? undefined : (
            <Freshness
              generatedAt={data.generatedAt}
              onRefresh={() => {
                void dashboard.refetch();
              }}
            />
          )
        }
      />
      <div className="flex flex-col gap-4" data-testid="executive-dashboard">
        <NeedsAttentionCard limit={5} />
        {dashboard.isPending ? (
          <SectionSkeleton />
        ) : dashboard.isError || data === undefined ? (
          <DashboardError
            error={dashboard.error}
            onRetry={() => {
              void dashboard.refetch();
            }}
          />
        ) : (
          <>
            {data.today === null ? null : (
              <SectionCard title={t('attendance.title')} testId="executive-attendance">
                <AttendanceTodayView section={data.today} />
              </SectionCard>
            )}
            {data.projects === null ? null : (
              <SectionCard title={t('projects.title')} testId="executive-projects">
                <ProjectsSectionView section={data.projects} />
              </SectionCard>
            )}
            {data.support === null ? null : (
              <SectionCard title={t('support.title')} testId="executive-support">
                <SupportSectionView section={data.support} />
              </SectionCard>
            )}
            <DevelopmentSectionView section={data.development} />
            {data.commercial === null ? null : <CommercialSectionView section={data.commercial} />}
          </>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {access.support ? <TrendCard metric="support_flow" title={t('support.trend')} /> : null}
          {access.team ? <TrendCard metric="attendance_presence" title={t('team.trend')} /> : null}
        </div>
      </div>
    </>
  );
}
