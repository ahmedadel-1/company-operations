'use client';

import { useTranslations } from 'next-intl';

import {
  DashboardError,
  DevelopmentSectionView,
  Freshness,
  ProjectsSectionView,
  SectionCard,
  SectionSkeleton,
  useDashboardAccess,
} from '../../../../components/dashboard';
import { Forbidden, PageHeader } from '../../../../components/states';
import { useProjectsDashboard } from '../../../../lib/dashboard';

/**
 * Project portfolio and development signals (project managers, department managers, the technical
 * manager). Jira and GitHub numbers come from the local cache with their freshness; per project only.
 */
export default function ProjectsDashboardPage() {
  const t = useTranslations('dashboard');
  const access = useDashboardAccess();
  const dashboard = useProjectsDashboard(access.projects);
  if (!access.projects) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('projects.pageTitle')}
        description={t('projects.description')}
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
      <div className="flex flex-col gap-4" data-testid="projects-dashboard">
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
          <>
            <SectionCard title={t('projects.title')}>
              <ProjectsSectionView section={dashboard.data.projects} />
            </SectionCard>
            <DevelopmentSectionView section={dashboard.data.development} />
          </>
        )}
      </div>
    </>
  );
}
