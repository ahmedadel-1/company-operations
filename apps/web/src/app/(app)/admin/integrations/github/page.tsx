'use client';

import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';

import {
  DeliveriesSection,
  GithubCallbackNotice,
  InstallationsCard,
  RepositoriesSection,
  RunsSection,
} from '../../../../../components/github-admin';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../../components/states';
import { useGithubStatus } from '../../../../../lib/github';
import { useCanOrgWide } from '../../../../../lib/session';

export default function GithubIntegrationPage() {
  return (
    <Suspense fallback={<ListSkeleton rows={4} />}>
      <GithubIntegration />
    </Suspense>
  );
}

function GithubIntegration() {
  const t = useTranslations('github.admin');
  const orgWide = useCanOrgWide();
  const params = useSearchParams();
  const status = useGithubStatus();
  if (!orgWide('integration.manage')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="flex flex-col gap-6">
        <GithubCallbackNotice outcome={params.get('github')} reason={params.get('reason')} />
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
            <InstallationsCard status={status.data} />
            <RepositoriesSection active={status.data.installations.length > 0} />
            <RunsSection active={status.data.installations.length > 0} />
            <DeliveriesSection active={status.data.installations.length > 0} />
          </>
        )}
      </div>
    </>
  );
}
