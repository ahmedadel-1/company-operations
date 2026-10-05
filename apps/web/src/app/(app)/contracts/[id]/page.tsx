'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Badge } from '@company-ops/ui/components/badge';

import {
  ContractStatusBadge,
  DocumentsPanel,
  GuaranteesPanel,
  HealthBadge,
  Timeline,
} from '../../../../components/commercial';
import {
  AmendmentsTab,
  ContractOverview,
  MilestonesTab,
  ObligationsTab,
  RenewalTab,
} from '../../../../components/contract-detail';
import { DetailTabs } from '../../../../components/detail-tabs';
import { ErrorState, ListSkeleton, PageHeader } from '../../../../components/states';
import { useContract } from '../../../../lib/commercial';
import type { Contract } from '../../../../lib/commercial';

const TABS = [
  'overview',
  'obligations',
  'milestones',
  'amendments',
  'renewal',
  'documents',
  'guarantees',
  'timeline',
] as const;
type Tab = (typeof TABS)[number];

export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  // No permission gate here: obligation and milestone owners may open the contract (the API decides).
  const contract = useContract(id);
  if (contract.isPending) {
    return <ListSkeleton rows={5} />;
  }
  if (contract.isError) {
    return (
      <ErrorState
        error={contract.error}
        onRetry={() => {
          void contract.refetch();
        }}
      />
    );
  }
  return <ContractDetail contract={contract.data} />;
}

function ContractDetail({ contract }: { readonly contract: Contract }) {
  const t = useTranslations('commercial');
  return (
    <>
      <PageHeader
        title={contract.title}
        description={[contract.key, contract.customer?.name ?? contract.counterpartyName].filter(Boolean).join(' · ')}
      />
      <div className="mb-4 flex flex-wrap gap-2" data-testid="contract-header">
        <ContractStatusBadge status={contract.status} />
        <HealthBadge health={contract.health} />
        {contract.expiring ? <Badge tone="warning">{t('expiringSoon')}</Badge> : null}
        {contract.accessLevel === 'INVOLVED' ? <Badge>{t('involvedAccess')}</Badge> : null}
      </div>
      <DetailTabs<Tab>
        tabs={TABS}
        label={t('contracts.sections')}
        labelOf={(tab) => t(`contracts.tabs.${tab}`)}
        render={(tab) =>
          tab === 'overview' ? (
            <ContractOverview contract={contract} />
          ) : tab === 'obligations' ? (
            <ObligationsTab contract={contract} />
          ) : tab === 'milestones' ? (
            <MilestonesTab contract={contract} />
          ) : tab === 'amendments' ? (
            <AmendmentsTab contract={contract} />
          ) : tab === 'renewal' ? (
            <RenewalTab contract={contract} />
          ) : tab === 'documents' ? (
            <DocumentsPanel parent="contracts" id={contract.id} canManage={contract.access.canManageDocuments} />
          ) : tab === 'guarantees' ? (
            <GuaranteesPanel parent="contracts" id={contract.id} canManage={contract.access.canManageGuarantees} />
          ) : (
            <Timeline parent="contracts" id={contract.id} />
          )
        }
      />
    </>
  );
}
