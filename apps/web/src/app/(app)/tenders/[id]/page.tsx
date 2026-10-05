'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Badge } from '@company-ops/ui/components/badge';

import {
  DocumentsPanel,
  GuaranteesPanel,
  ReadinessBadge,
  TenderStatusBadge,
  Timeline,
} from '../../../../components/commercial';
import { DetailTabs } from '../../../../components/detail-tabs';
import { ErrorState, ListSkeleton, PageHeader } from '../../../../components/states';
import {
  AddendaTab,
  RequirementsTab,
  ReviewsTab,
  SubmissionTab,
  TenderOverview,
} from '../../../../components/tender-detail';
import { useTender } from '../../../../lib/commercial';
import type { Tender } from '../../../../lib/commercial';

const TABS = [
  'overview',
  'requirements',
  'reviews',
  'documents',
  'submission',
  'addenda',
  'guarantees',
  'timeline',
] as const;
type Tab = (typeof TABS)[number];

export default function TenderPage() {
  const { id } = useParams<{ id: string }>();
  // No permission gate here: members involved in one requirement may open the tender (the API decides).
  const tender = useTender(id);
  if (tender.isPending) {
    return <ListSkeleton rows={5} />;
  }
  if (tender.isError) {
    return (
      <ErrorState
        error={tender.error}
        onRetry={() => {
          void tender.refetch();
        }}
      />
    );
  }
  return <TenderDetail tender={tender.data} />;
}

function TenderDetail({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  return (
    <>
      <PageHeader
        title={tender.title}
        description={[tender.key, tender.customer?.name ?? tender.counterpartyName].filter(Boolean).join(' · ')}
      />
      <div className="mb-4 flex flex-wrap gap-2" data-testid="tender-header">
        <TenderStatusBadge status={tender.status} />
        <ReadinessBadge readiness={tender.readiness} />
        {tender.accessLevel === 'INVOLVED' ? <Badge>{t('involvedAccess')}</Badge> : null}
        {tender.pendingReviews > 0 ? (
          <Badge tone="warning">{t('reviews.pending', { count: tender.pendingReviews })}</Badge>
        ) : null}
      </div>
      <DetailTabs<Tab>
        tabs={TABS}
        label={t('tenders.sections')}
        labelOf={(tab) => t(`tenders.tabs.${tab}`)}
        render={(tab) =>
          tab === 'overview' ? (
            <TenderOverview tender={tender} />
          ) : tab === 'requirements' ? (
            <RequirementsTab tender={tender} />
          ) : tab === 'reviews' ? (
            <ReviewsTab tender={tender} />
          ) : tab === 'documents' ? (
            <DocumentsPanel parent="tenders" id={tender.id} canManage={tender.access.canManageDocuments} />
          ) : tab === 'submission' ? (
            <SubmissionTab tender={tender} />
          ) : tab === 'addenda' ? (
            <AddendaTab tender={tender} />
          ) : tab === 'guarantees' ? (
            <GuaranteesPanel parent="tenders" id={tender.id} canManage={tender.access.canManageGuarantees} />
          ) : (
            <Timeline parent="tenders" id={tender.id} />
          )
        }
      />
    </>
  );
}
