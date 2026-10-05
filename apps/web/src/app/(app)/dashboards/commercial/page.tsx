'use client';

import { useTranslations } from 'next-intl';

import { CommercialReports, CommercialSectionView } from '../../../../components/commercial-dashboard';
import { DashboardError, Freshness, SectionSkeleton } from '../../../../components/dashboard';
import { Forbidden, PageHeader } from '../../../../components/states';
import { useCommercialDashboard } from '../../../../lib/commercial';
import { useCan } from '../../../../lib/session';

/** Tender pipeline, contract lifecycle and document validity in the caller's visibility (ADR-0026). */
export default function CommercialDashboardPage() {
  const t = useTranslations('commercial');
  const can = useCan();
  const allowed = can('tender.view') || can('contract.view') || can('corporate_document.view');
  const dashboard = useCommercialDashboard(allowed);
  if (!allowed) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        description={t('dashboard.description')}
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
      <div className="flex flex-col gap-4" data-testid="commercial-dashboard">
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
          <CommercialSectionView section={dashboard.data.commercial} />
        )}
        <CommercialReports />
      </div>
    </>
  );
}
