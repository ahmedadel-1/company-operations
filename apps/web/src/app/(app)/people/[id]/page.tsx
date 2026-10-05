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
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Label, NativeSelect } from '@company-ops/ui/components/input';

import { AvatarCard } from '../../../../components/avatar';
import { FormError, StatusMessage } from '../../../../components/form';
import {
  DetailList,
  EmployeeForm,
  EmploymentStatusBadge,
  InvitationNotice,
  MemberStatusBadge,
} from '../../../../components/people';
import type { Employee, Invitation } from '../../../../components/people';
import { ProjectStatusBadge } from '../../../../components/projects';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request, requestEmpty } from '../../../../lib/api';
import { useDateFormat } from '../../../../lib/format';
import { useEmployeeProjects } from '../../../../lib/projects';
import { queryKeys, useEmployee, useMemberRoles, useRoles } from '../../../../lib/queries';
import { useCan } from '../../../../lib/session';

export default function EmployeePage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const employee = useEmployee(id);

  if (!can('employee.view')) {
    return <Forbidden />;
  }
  if (employee.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (employee.isError) {
    return (
      <ErrorState
        error={employee.error}
        onRetry={() => {
          void employee.refetch();
        }}
      />
    );
  }
  return <EmployeeDetail employee={employee.data} />;
}

function EmployeeDetail({ employee }: { readonly employee: Employee }) {
  const t = useTranslations();
  const can = useCan();
  const { date } = useDateFormat();
  const contact = (value: string | null) => (employee.contactVisible ? value : t('people.contactHidden'));

  return (
    <>
      <PageHeader
        title={employee.fullName}
        actions={can('employee.manage') ? <EditEmployeeButton employee={employee} /> : undefined}
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <EmploymentStatusBadge status={employee.employmentStatus} />
        <MemberStatusBadge status={employee.memberStatus} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('profile.employment')}</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailList
              items={[
                [t('people.employeeNumber'), employee.employeeNumber],
                [t('people.department'), employee.department?.name ?? null],
                [t('people.jobTitle'), employee.jobTitle?.name ?? null],
                [t('people.manager'), employee.manager?.fullName ?? null],
                [t('people.employmentType'), t(`people.employmentTypes.${employee.employmentType}`)],
                [t('people.joinDate'), employee.joinDate === null ? null : date(employee.joinDate)],
                [t('people.workEmail'), contact(employee.workEmail)],
                [t('people.phone'), contact(employee.phone)],
                [t('people.timeZone'), employee.timeZone],
              ]}
            />
          </CardContent>
        </Card>
        <AvatarCard employee={employee} canChange={can('employee.manage')} />
        <RolesCard employee={employee} />
        {can('project.view') ? <EmployeeProjectsCard employeeId={employee.id} /> : null}
        {can('employee.manage') ? <AccessCard employee={employee} /> : null}
      </div>
    </>
  );
}

function EditEmployeeButton({ employee }: { readonly employee: Employee }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('common.edit')}
      </Button>
      <DialogContent title={t('people.editEmployee')} closeLabel={t('common.close')}>
        <EmployeeForm
          employee={employee}
          onSaved={() => {
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The employee's projects that the viewer may see (the API filters by the viewer's project scope). */
function EmployeeProjectsCard({ employeeId }: { readonly employeeId: string }) {
  const t = useTranslations();
  const projects = useEmployeeProjects(employeeId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {projects.isPending ? (
          <ListSkeleton rows={2} />
        ) : projects.isError ? (
          <ErrorState error={projects.error} />
        ) : projects.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('projects.noneForEmployee')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {projects.data.map(({ project, roles }) => (
              <li key={project.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/projects/${project.id}`} className="underline-offset-4 hover:underline">
                  {project.name} <span className="text-sm text-muted-foreground">· {project.code}</span>
                </Link>
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  {roles.map((role) => t(`projects.roles.${role}`)).join(', ')}
                  <ProjectStatusBadge status={project.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AccessCard({ employee }: { readonly employee: Employee }) {
  const t = useTranslations('people');
  const queryClient = useQueryClient();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['employees'] });

  const setStatus = useMutation({
    mutationFn: (status: 'ACTIVE' | 'DISABLED') =>
      request(() =>
        api.PUT('/api/v1/employees/{id}/status', { params: { path: { id: employee.id } }, body: { status } }),
      ),
    onSuccess: async () => {
      setMessage(t('statusChanged'));
      await refresh();
    },
  });
  const reissue = useMutation({
    mutationFn: () =>
      request(() => api.POST('/api/v1/employees/{id}/invitation', { params: { path: { id: employee.id } } })),
    onSuccess: (result) => {
      setMessage(null);
      setInvitation(result.data);
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      requestEmpty(() => api.DELETE('/api/v1/employees/{id}/invitation', { params: { path: { id: employee.id } } })),
    onSuccess: async () => {
      setInvitation(null);
      setMessage(t('invitationRevoked'));
      await refresh();
    },
  });
  const error = setStatus.error ?? reissue.error ?? revoke.error;
  const busy = setStatus.isPending || reissue.isPending || revoke.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('access')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FormError error={error} />
        <div className="flex flex-wrap gap-2">
          {employee.memberStatus === 'ACTIVE' ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setStatus.mutate('DISABLED');
              }}
            >
              {t('disableAccount')}
            </Button>
          ) : null}
          {employee.memberStatus === 'DISABLED' ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setStatus.mutate('ACTIVE');
              }}
            >
              {t('enableAccount')}
            </Button>
          ) : null}
          {employee.memberStatus === 'INVITED' ? (
            <>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  reissue.mutate();
                }}
              >
                {t('reissueInvitation')}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  revoke.mutate();
                }}
              >
                {t('revokeInvitation')}
              </Button>
            </>
          ) : null}
        </div>
        {message === null ? null : <StatusMessage>{message}</StatusMessage>}
        {invitation === null ? null : <InvitationNotice invitation={invitation} />}
      </CardContent>
    </Card>
  );
}

function RolesCard({ employee }: { readonly employee: Employee }) {
  const t = useTranslations();
  const can = useCan();
  const queryClient = useQueryClient();
  const manage = can('role.manage');
  const assigned = useMemberRoles(employee.memberId);
  const roles = useRoles(manage);
  const [roleId, setRoleId] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.memberRoles(employee.memberId) });

  const grant = useMutation({
    mutationFn: (id: string) =>
      request(() =>
        api.POST('/api/v1/members/{memberId}/roles', {
          params: { path: { memberId: employee.memberId } },
          body: { roleId: id },
        }),
      ),
    onSuccess: async () => {
      setRoleId('');
      setMessage(t('people.roleGranted'));
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      requestEmpty(() =>
        api.DELETE('/api/v1/members/{memberId}/roles/{roleId}', {
          params: { path: { memberId: employee.memberId, roleId: id } },
        }),
      ),
    onSuccess: async () => {
      setMessage(t('people.roleRevoked'));
      await refresh();
    },
  });

  const assignedIds = new Set((assigned.data ?? []).map((role) => role.roleId));
  const grantable = (roles.data ?? []).filter((role) => !assignedIds.has(role.id));
  const onGrant = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (roleId !== '') {
      grant.mutate(roleId);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('people.roles')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {assigned.isPending ? (
          <ListSkeleton rows={2} />
        ) : assigned.isError ? (
          <ErrorState
            error={assigned.error}
            onRetry={() => {
              void assigned.refetch();
            }}
          />
        ) : assigned.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('people.noRoles')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label={t('people.roles')}>
            {assigned.data.map((role) => (
              <li key={role.roleId}>
                <Badge className="gap-1 py-1">
                  {role.name}
                  {manage ? (
                    <button
                      type="button"
                      className="-me-1 inline-flex size-6 items-center justify-center rounded hover:bg-accent"
                      aria-label={t('people.revokeRole', { role: role.name })}
                      disabled={revoke.isPending}
                      onClick={() => {
                        revoke.mutate(role.roleId);
                      }}
                    >
                      <XIcon aria-hidden="true" className="size-3" />
                    </button>
                  ) : null}
                </Badge>
              </li>
            ))}
          </ul>
        )}
        {manage ? (
          <form onSubmit={onGrant} className="flex flex-wrap items-end gap-2">
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label htmlFor="grant-role">{t('people.role')}</Label>
              <NativeSelect
                id="grant-role"
                value={roleId}
                onChange={(event) => {
                  setRoleId(event.target.value);
                }}
              >
                <option value="">{t('common.none')}</option>
                {grantable.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.administratorEquivalent ? `${role.name} (${t('people.administratorEquivalent')})` : role.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" disabled={roleId === '' || grant.isPending}>
              {t('people.grantRole')}
            </Button>
          </form>
        ) : null}
        <FormError error={grant.error ?? revoke.error} />
        {message === null ? null : <StatusMessage>{message}</StatusMessage>}
      </CardContent>
    </Card>
  );
}
