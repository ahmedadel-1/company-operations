'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Label, NativeSelect } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import { projectKeys } from '../lib/projects';
import type { Project } from '../lib/projects';
import { useTeams } from '../lib/queries';
import { useCan } from '../lib/session';
import { supportKeys, TICKET_STATUSES, useProjectSupport, useTickets } from '../lib/support';
import { FormError, StatusMessage } from './form';
import { EmptyState, ErrorState, ListSkeleton } from './states';
import { TicketList } from './support';

/** Project Support tab: scoped counts, the support team for new tickets and the open queue. */
export function SupportTab({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const can = useCan();
  const summary = useProjectSupport(project.id);
  const tickets = useTickets({ view: 'open', projectId: project.id });
  const rows = (tickets.data?.pages[0]?.data ?? []).slice(0, 10);

  if (summary.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (summary.isError) {
    return (
      <ErrorState
        error={summary.error}
        onRetry={() => {
          void summary.refetch();
        }}
      />
    );
  }
  const data = summary.data;
  const stats = [
    [t('support.projectTab.open'), data.openCount],
    [t('support.projectTab.critical'), data.criticalOpenCount],
    [t('support.projectTab.slaRisk'), data.slaRiskCount],
  ] as const;
  const byStatus = TICKET_STATUSES.flatMap((status) => {
    const count = (data.byStatus as Partial<Record<string, number>>)[status];
    return count === undefined || count === 0 ? [] : [[status, count] as const];
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {can('support.create') && project.status !== 'ARCHIVED' ? (
          <Button asChild>
            <Link href={`/support/new?projectId=${project.id}`}>
              <PlusIcon aria-hidden="true" />
              {t('support.projectTab.newTicket')}
            </Link>
          </Button>
        ) : null}
        <Button asChild variant="outline">
          <Link href={`/support?view=open&projectId=${project.id}`}>{t('support.projectTab.viewAll')}</Link>
        </Button>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        {stats.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 rounded-lg border p-4">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('support.projectTab.byStatus')}</CardTitle>
          </CardHeader>
          <CardContent>
            {byStatus.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('support.empty')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2 text-sm">
                {byStatus.map(([status, count]) => (
                  <li key={status} className="rounded-md border px-2 py-1">
                    {t(`support.statuses.${status}`)}: {count}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <SupportTeamCard project={project} team={data.supportTeam} canManage={data.canManageSupportTeam} />
      </div>
      <section aria-labelledby="project-support-recent" className="flex flex-col gap-3">
        <h2 id="project-support-recent" className="text-lg font-semibold">
          {t('support.projectTab.recent')}
        </h2>
        {tickets.isPending ? (
          <ListSkeleton rows={3} />
        ) : tickets.isError ? (
          <ErrorState error={tickets.error} />
        ) : rows.length === 0 ? (
          <EmptyState message={t('support.empty')} />
        ) : (
          <TicketList tickets={rows} label={t('support.projectTab.recent')} />
        )}
      </section>
    </div>
  );
}

function SupportTeamCard({
  project,
  team,
  canManage,
}: {
  readonly project: Project;
  readonly team: { readonly id: string; readonly name: string } | null;
  readonly canManage: boolean;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const teams = useTeams();
  const [teamId, setTeamId] = useState(team?.id ?? '');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.PUT('/api/v1/projects/{id}/support-team', {
          params: { path: { id: project.id } },
          body: { teamId: teamId === '' ? null : teamId, version: project.version },
        }),
      ),
    onSuccess: async () => {
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: supportKeys.project(project.id) }),
        queryClient.invalidateQueries({ queryKey: projectKeys.detail(project.id) }),
        queryClient.invalidateQueries({ queryKey: projectKeys.activity(project.id) }),
      ]);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('support.projectTab.supportTeam')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p>{team === null ? t('support.projectTab.noSupportTeam') : team.name}</p>
        {canManage ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSaved(false);
              save.mutate();
            }}
          >
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label htmlFor="project-support-team">{t('support.projectTab.changeTeam')}</Label>
              <NativeSelect
                id="project-support-team"
                value={teamId}
                onChange={(event) => {
                  setTeamId(event.target.value);
                }}
              >
                <option value="">{t('support.noTeam')}</option>
                {(teams.data ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" variant="outline" disabled={save.isPending || teamId === (team?.id ?? '')}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </form>
        ) : null}
        <FormError error={save.error} />
        {saved ? <StatusMessage>{t('support.projectTab.teamSaved')}</StatusMessage> : null}
      </CardContent>
    </Card>
  );
}
