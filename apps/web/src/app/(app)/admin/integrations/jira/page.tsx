'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';

import {
  CallbackNotice,
  ConnectionCard,
  DeliveryFailures,
  MappingsSection,
  SiteSelection,
} from '../../../../../components/jira-admin';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../../components/states';
import { useJiraStatus } from '../../../../../lib/jira';
import { useCanOrgWide } from '../../../../../lib/session';

export default function JiraIntegrationPage() {
  return (
    <Suspense fallback={<ListSkeleton rows={4} />}>
      <JiraIntegration />
    </Suspense>
  );
}

function JiraIntegration() {
  const t = useTranslations('jira.admin');
  const orgWide = useCanOrgWide();
  const params = useSearchParams();
  const router = useRouter();
  const status = useJiraStatus();
  if (!orgWide('integration.manage')) {
    return <Forbidden />;
  }
  const outcome = params.get('jira');
  const grant = outcome === 'select-site' ? params.get('grant') : null;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-6">
        <CallbackNotice outcome={outcome} reason={params.get('reason')} />
        {grant === null ? null : (
          <SiteSelection
            grantId={grant}
            onDone={() => {
              router.replace('/admin/integrations/jira?jira=connected');
            }}
          />
        )}
        {status.isPending ? (
          <ListSkeleton rows={4} />
        ) : status.isError ? (
          <ErrorState
            error={status.error}
            onRetry={() => {
              void status.refetch();
            }}
          />
        ) : (
          <>
            <ConnectionCard status={status.data} />
            <MappingsSection
              connected={status.data.connection !== null && status.data.connection.status !== 'NEEDS_REAUTH'}
            />
            <DeliveryFailures connected={status.data.connection !== null} />
          </>
        )}
      </div>
    </>
  );
}
