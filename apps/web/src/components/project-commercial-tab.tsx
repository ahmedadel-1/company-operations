'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useProjectCommercial } from '../lib/commercial';
import type { Project } from '../lib/projects';
import { useDateFormat } from '../lib/format';
import {
  ContractList,
  DueDate,
  GuaranteeList,
  MilestoneStatusBadge,
  ObligationStatusBadge,
  Section,
  TenderStatusBadge,
} from './commercial';
import { EmptyState, ErrorState, ListSkeleton } from './states';

/** Tenders, contracts and upcoming commitments linked to the project, in the caller's visibility. */
export function CommercialTab({ project }: { readonly project: Project }) {
  const t = useTranslations('commercial');
  const { dateTime } = useDateFormat();
  const data = useProjectCommercial(project.id);
  if (data.isPending) return <ListSkeleton rows={4} />;
  if (data.isError) {
    return (
      <ErrorState
        error={data.error}
        onRetry={() => {
          void data.refetch();
        }}
      />
    );
  }
  const { tenders, contracts, upcomingObligations, milestones, guarantees } = data.data;
  if (tenders.length + contracts.length + upcomingObligations.length + milestones.length + guarantees.length === 0) {
    return <EmptyState message={t('project.empty')} />;
  }
  return (
    <div className="flex flex-col gap-6" data-testid="project-commercial">
      {contracts.length === 0 ? null : (
        <Section title={t('project.contracts')}>
          <ContractList contracts={contracts} label={t('project.contracts')} />
        </Section>
      )}
      {tenders.length === 0 ? null : (
        <Section title={t('project.tenders')}>
          <ul className="flex flex-col gap-2">
            {tenders.map((tender) => (
              <li key={tender.id}>
                <Link
                  href={`/tenders/${tender.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 hover:bg-accent"
                >
                  <span className="font-medium">
                    {tender.key} · {tender.title}
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    {tender.submissionDeadlineAt === null ? null : (
                      <time dateTime={tender.submissionDeadlineAt}>{dateTime(tender.submissionDeadlineAt)}</time>
                    )}
                    <TenderStatusBadge status={tender.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {upcomingObligations.length === 0 ? null : (
        <Section title={t('project.obligations')}>
          <ul className="flex flex-col gap-2">
            {upcomingObligations.map((occurrence) => (
              <li key={occurrence.id}>
                <Link
                  href={`/contracts/${occurrence.contractId}#obligations`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 hover:bg-accent"
                >
                  <span className="font-medium">{occurrence.title}</span>
                  <span className="flex items-center gap-2 text-sm">
                    <DueDate date={occurrence.dueDate} overdue={occurrence.status === 'OVERDUE'} />
                    <ObligationStatusBadge status={occurrence.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {milestones.length === 0 ? null : (
        <Section title={t('project.milestones')}>
          <ul className="flex flex-col gap-2">
            {milestones.map((milestone) => (
              <li key={milestone.id}>
                <Link
                  href={`/contracts/${milestone.contractId}#milestones`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 hover:bg-accent"
                >
                  <span className="font-medium">{milestone.title}</span>
                  <span className="flex items-center gap-2 text-sm">
                    <DueDate date={milestone.dueDate} overdue={milestone.status === 'OVERDUE'} />
                    <MilestoneStatusBadge status={milestone.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {guarantees.length === 0 ? null : (
        <Section title={t('project.guarantees')}>
          <GuaranteeList guarantees={guarantees} />
        </Section>
      )}
    </div>
  );
}
