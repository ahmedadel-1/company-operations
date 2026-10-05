'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';

import { EmployeePicker } from '../../../../components/employee-picker';
import type { PickedEmployee } from '../../../../components/employee-picker';
import { FormError } from '../../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request, requestEmpty } from '../../../../lib/api';
import { queryKeys, useTeam, useTeamMembers } from '../../../../lib/queries';
import { useCan } from '../../../../lib/session';
import { TeamDialog } from '../../../../components/teams';
import type { Team } from '../../../../components/teams';

export default function TeamPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const team = useTeam(id);
  if (!can('employee.view')) {
    return <Forbidden />;
  }
  if (team.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (team.isError) {
    return (
      <ErrorState
        error={team.error}
        onRetry={() => {
          void team.refetch();
        }}
      />
    );
  }
  return <TeamDetail team={team.data} />;
}

function TeamDetail({ team }: { readonly team: Team }) {
  const t = useTranslations();
  const can = useCan();
  const manage = can('department.manage');
  const queryClient = useQueryClient();
  const members = useTeamMembers(team.id);
  const [picked, setPicked] = useState<PickedEmployee | null>(null);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.teamMembers(team.id) }),
      queryClient.invalidateQueries({ queryKey: ['teams', 'list'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.team(team.id) }),
    ]);

  const add = useMutation({
    mutationFn: (employeeId: string) =>
      request(() =>
        api.PUT('/api/v1/teams/{id}/members/{employeeId}', { params: { path: { id: team.id, employeeId } } }),
      ),
    onSuccess: async () => {
      setPicked(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (employeeId: string) =>
      requestEmpty(() =>
        api.DELETE('/api/v1/teams/{id}/members/{employeeId}', { params: { path: { id: team.id, employeeId } } }),
      ),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: () =>
      team.archived
        ? request(() => api.POST('/api/v1/teams/{id}/unarchive', { params: { path: { id: team.id } } }))
        : request(() => api.POST('/api/v1/teams/{id}/archive', { params: { path: { id: team.id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams'] }),
  });

  const onAdd = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (picked !== null) {
      add.mutate(picked.id);
    }
  };

  return (
    <>
      <PageHeader
        title={team.name}
        description={`${team.department?.name ?? t('teams.noDepartment')}${team.lead === null ? '' : ` · ${t('teams.lead')}: ${team.lead.fullName}`}`}
        actions={
          manage ? (
            <>
              <TeamDialog team={team} />
              <Button
                variant="outline"
                disabled={archive.isPending}
                onClick={() => {
                  archive.mutate();
                }}
              >
                {team.archived ? t('common.unarchive') : t('common.archive')}
              </Button>
            </>
          ) : undefined
        }
      />
      {team.archived ? <Badge className="mb-4">{t('common.archived')}</Badge> : null}
      <FormError error={archive.error} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('teams.membersTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            {members.isPending ? (
              <ListSkeleton rows={3} />
            ) : members.isError ? (
              <ErrorState
                error={members.error}
                onRetry={() => {
                  void members.refetch();
                }}
              />
            ) : members.data.length === 0 ? (
              <EmptyState message={t('teams.noMembers')} />
            ) : (
              <ul className="flex flex-col divide-y">
                {members.data.map((member) => (
                  <li key={member.employeeId} className="flex min-h-12 items-center justify-between gap-3 py-2">
                    <Link href={`/people/${member.employeeId}`} className="underline-offset-4 hover:underline">
                      {member.fullName} <span className="text-sm text-muted-foreground">· {member.employeeNumber}</span>
                    </Link>
                    {manage ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('teams.removeMember', { name: member.fullName })}
                        disabled={remove.isPending}
                        onClick={() => {
                          remove.mutate(member.employeeId);
                        }}
                      >
                        <XIcon aria-hidden="true" />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <FormError error={remove.error} />
          </CardContent>
        </Card>
        {manage && !team.archived ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('teams.addMember')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={onAdd} className="flex flex-col gap-3">
                <FormError error={add.error} />
                <EmployeePicker label={t('teams.employee')} value={picked} onChange={setPicked} />
                <Button type="submit" className="self-end" disabled={picked === null || add.isPending}>
                  {t('teams.addMember')}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </>
  );
}
