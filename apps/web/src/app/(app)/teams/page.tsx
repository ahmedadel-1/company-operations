'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Badge } from '@company-ops/ui/components/badge';

import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { TeamDialog } from '../../../components/teams';
import { useTeams } from '../../../lib/queries';
import { useCan } from '../../../lib/session';

export default function TeamsPage() {
  const t = useTranslations();
  const can = useCan();
  const [showArchived, setShowArchived] = useState(false);
  const teams = useTeams(showArchived);
  if (!can('employee.view')) {
    return <Forbidden />;
  }

  return (
    <>
      <PageHeader title={t('teams.title')} actions={can('department.manage') ? <TeamDialog /> : undefined} />
      <label className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => {
            setShowArchived(event.target.checked);
          }}
        />
        {t('departments.showArchived')}
      </label>
      {teams.isPending ? (
        <ListSkeleton />
      ) : teams.isError ? (
        <ErrorState
          error={teams.error}
          onRetry={() => {
            void teams.refetch();
          }}
        />
      ) : teams.data.length === 0 ? (
        <EmptyState message={t('teams.empty')} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={t('teams.title')}>
          {teams.data.map((team) => (
            <li key={team.id}>
              <Link
                href={`/teams/${team.id}`}
                className="flex h-full flex-col gap-1 rounded-lg border p-4 hover:bg-accent"
              >
                <span className="flex items-center justify-between gap-2 font-medium">
                  {team.name}
                  {team.archived ? <Badge>{t('common.archived')}</Badge> : null}
                </span>
                <span className="text-sm text-muted-foreground">
                  {team.department?.name ?? t('teams.noDepartment')} · {t('teams.members', { count: team.memberCount })}
                </span>
                {team.lead === null ? null : (
                  <span className="text-sm text-muted-foreground">
                    {t('teams.lead')}: {team.lead.fullName}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
