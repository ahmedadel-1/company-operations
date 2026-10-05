'use client';

import { DownloadIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { CONTRACT_REPORTS, FINANCIAL_REPORTS, TENDER_REPORTS, reportUrl } from '../lib/commercial';
import type { CommercialReport, CommercialSection } from '../lib/commercial';
import { useCan } from '../lib/session';
import { formatMoney } from './commercial';
import { MetricGrid, MetricTile, SectionCard } from './dashboard';

/** Tender, contract and document numbers; each group renders only when the API returned it. */
export function CommercialSectionView({ section }: { readonly section: CommercialSection }) {
  const t = useTranslations('commercial.dashboard');
  return (
    <div className="flex flex-col gap-4">
      {section.tenders === null ? null : (
        <SectionCard title={t('tenders')} testId="commercial-tenders">
          <MetricGrid label={t('tenders')}>
            <MetricTile label={t('activeTenders')} metric={section.tenders.active} testId="metric-tenders-active" />
            <MetricTile
              label={t('closingIn7Days')}
              metric={section.tenders.closingIn7Days}
              tone="warning"
              testId="metric-tenders-7d"
            />
            <MetricTile
              label={t('closingIn30Days')}
              metric={section.tenders.closingIn30Days}
              testId="metric-tenders-30d"
            />
            <MetricTile
              label={t('notReady')}
              metric={section.tenders.notReady}
              tone="danger"
              testId="metric-tenders-not-ready"
            />
            <MetricTile
              label={t('awaitingFinalApproval')}
              metric={section.tenders.awaitingFinalApproval}
              tone="warning"
              testId="metric-tenders-final"
            />
            <MetricTile
              label={t('submittedThisMonth')}
              metric={section.tenders.submittedThisMonth}
              testId="metric-tenders-submitted"
            />
            <MetricTile label={t('awardedYtd')} metric={section.tenders.awardedYtd} testId="metric-tenders-awarded" />
            <MetricTile label={t('lostYtd')} metric={section.tenders.lostYtd} testId="metric-tenders-lost" />
          </MetricGrid>
        </SectionCard>
      )}
      {section.contracts === null ? null : (
        <SectionCard title={t('contracts')} testId="commercial-contracts">
          <MetricGrid label={t('contracts')}>
            <MetricTile
              label={t('activeContracts')}
              metric={section.contracts.active}
              testId="metric-contracts-active"
            />
            <MetricTile
              label={t('expiringIn90Days')}
              metric={section.contracts.expiringIn90Days}
              tone="warning"
              testId="metric-contracts-expiring"
            />
            <MetricTile
              label={t('renewalRequired')}
              metric={section.contracts.renewalRequired}
              tone="warning"
              testId="metric-contracts-renewal"
            />
            <MetricTile
              label={t('noticeApproaching')}
              metric={section.contracts.noticeApproaching}
              tone="warning"
              testId="metric-contracts-notice"
            />
            <MetricTile
              label={t('withOverdueObligations')}
              metric={section.contracts.withOverdueObligations}
              tone="danger"
              testId="metric-contracts-obligations"
            />
            <MetricTile
              label={t('withOverdueMilestones')}
              metric={section.contracts.withOverdueMilestones}
              tone="danger"
              testId="metric-contracts-milestones"
            />
            <MetricTile
              label={t('expiringGuarantees')}
              metric={section.contracts.expiringGuarantees}
              tone="warning"
              testId="metric-contracts-guarantees"
            />
            <MetricTile
              label={t('atRisk')}
              metric={section.contracts.atRisk}
              tone="danger"
              testId="metric-contracts-at-risk"
            />
          </MetricGrid>
          {section.activeContractValue === null ? null : (
            <div className="flex flex-col gap-1" data-testid="active-contract-value">
              <span className="text-sm text-muted-foreground">{t('activeValue')}</span>
              {section.activeContractValue.length === 0 ? (
                <span className="text-sm">{t('noValue')}</span>
              ) : (
                <ul className="flex flex-wrap gap-4">
                  {section.activeContractValue.map((money) => (
                    <li key={money.currency} className="text-xl font-semibold tabular-nums">
                      <bdi dir="ltr">{formatMoney(money)}</bdi>
                    </li>
                  ))}
                </ul>
              )}
              <span className="text-xs text-muted-foreground">{t('valueHint')}</span>
            </div>
          )}
        </SectionCard>
      )}
      {section.documents === null ? null : (
        <SectionCard title={t('documents')} testId="commercial-documents">
          <MetricGrid label={t('documents')}>
            <MetricTile
              label={t('documentsExpiring')}
              metric={section.documents.expiring}
              tone="warning"
              testId="metric-documents-expiring"
            />
            <MetricTile
              label={t('documentsExpired')}
              metric={section.documents.expired}
              tone="danger"
              testId="metric-documents-expired"
            />
          </MetricGrid>
        </SectionCard>
      )}
    </div>
  );
}

/** CSV downloads; the API re-checks every permission and omits money columns the caller may not see. */
export function CommercialReports() {
  const t = useTranslations('commercial');
  const can = useCan();
  const visible = (report: CommercialReport) => !FINANCIAL_REPORTS.includes(report) || can('contract.financial.view');
  const groups: readonly (readonly [string, readonly CommercialReport[]])[] = [
    ...(can('tender.view') ? [[t('dashboard.tenderReports'), TENDER_REPORTS] as const] : []),
    ...(can('contract.view') ? [[t('dashboard.contractReports'), CONTRACT_REPORTS.filter(visible)] as const] : []),
  ];
  if (groups.length === 0) {
    return null;
  }
  return (
    <SectionCard title={t('dashboard.reports')} testId="commercial-reports">
      <div className="grid gap-4 md:grid-cols-2">
        {groups.map(([title, reports]) => (
          <div key={title} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            <ul className="flex flex-col gap-1">
              {reports.map((report) => (
                <li key={report}>
                  <a
                    href={reportUrl(report)}
                    download
                    className="inline-flex min-h-11 items-center gap-2 text-sm underline-offset-4 hover:underline"
                    data-testid={`report-${report}`}
                  >
                    <DownloadIcon aria-hidden="true" className="size-4" />
                    {t(`reports.${report}`)}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
