'use client';

import { useTranslations } from 'next-intl';

import {
  DashboardError,
  Freshness,
  SectionCard,
  SectionSkeleton,
  SupportSectionView,
  TrendCard,
  useDashboardAccess,
} from '../../../../components/dashboard';
import { Forbidden, PageHeader } from '../../../../components/states';
import { useSupportDashboard } from '../../../../lib/dashboard';

/** Support queue health for members who work tickets (ADR-0023). Queue numbers only; never per agent. */
export default function SupportDashboardPage() {
  const t = useTranslations('dashboard');
  const access = useDashboardAccess();
  const dashboard = useSupportDashboard(access.support);
  if (!access.support) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('support.pageTitle')}
        description={t('support.description')}
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
      <div className="flex flex-col gap-4" data-testid="support-dashboard">
        <SectionCard title={t('support.title')}>
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
            <SupportSectionView section={dashboard.data.support} />
          )}
        </SectionCard>
        <TrendCard metric="support_flow" title={t('support.trend')} />
      </div>
    </>
  );
}
