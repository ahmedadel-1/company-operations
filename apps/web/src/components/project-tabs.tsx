'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { XIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { api, request, requestEmpty } from '../lib/api';
import { useDateFormat } from '../lib/format';
import {
  PROJECT_HEALTHS,
  PROJECT_ROLES,
  projectKeys,
  REPORT_STATUSES,
  SETTABLE_STATUSES,
  useMissingReports,
  useProjectActivity,
  useProjectLocations,
  useProjectMembers,
  useProjectReports,
  useWorkLocations,
} from '../lib/projects';
import type { MissingReports, Project, ProjectRole, ReportFilters } from '../lib/projects';
import { EmployeePicker } from './employee-picker';
import type { PickedEmployee } from './employee-picker';
import { Field, fieldErrorsOf, FormError, StatusMessage } from './form';
import { DetailList } from './people';
import { ProjectForm, ReportStatusBadge, useActivityText, usePersonLabel } from './projects';
import { EmptyState, ErrorState, ListSkeleton } from './states';

const MANAGER_ROLES: readonly ProjectRole[] = ['PROJECT_MANAGER', 'TECHNICAL_MANAGER'];

function useProjectRefresh(projectId: string) {
  const queryClient = useQueryClient();
  return {
    queryClient,
    saved: async (project: Project) => {
      queryClient.setQueryData(projectKeys.detail(project.id), project);
      await queryClient.invalidateQueries({ queryKey: projectKeys.all });
    },
    invalidate: () => queryClient.invalidateQueries({ queryKey: projectKeys.all }),
    detail: () => queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectId) }),
  };
}

// ---- Overview ----

export function OverviewTab({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const { date, dateTime } = useDateFormat();
  const personLabel = usePersonLabel();
  const members = useProjectMembers(project.id);
  const locations = useProjectLocations(project.id);
  const activity = useProjectActivity(project.id, 5);
  const missing = useMissingReports(project.id, project.access.canViewReports);
  const activityText = useActivityText();
  const byRole = new Map<ProjectRole, number>();
  for (const member of members.data ?? []) {
    byRole.set(member.projectRole, (byRole.get(member.projectRole) ?? 0) + 1);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t('projects.overview.details')}</CardTitle>
        </CardHeader>
        <CardContent>
          <DetailList
            items={[
              [t('projects.status'), t(`projects.statuses.${project.status}`)],
              [t('projects.statusReason'), project.statusReason],
              [t('projects.health'), t(`projects.healths.${project.health}`)],
              [t('projects.healthNote'), project.healthNote],
              [t('projects.customer'), project.customer?.name ?? null],
              [t('projects.startDate'), project.startDate === null ? null : date(project.startDate)],
              [t('projects.targetEndDate'), project.targetEndDate === null ? null : date(project.targetEndDate)],
              [t('projects.projectManager'), personLabel(project.projectManager)],
              [t('projects.technicalManager'), personLabel(project.technicalManager)],
              [t('projects.timeZone'), project.effectiveTimeZone],
              [t('projects.description'), project.description],
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('projects.overview.team')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {members.isPending ? (
            <ListSkeleton rows={2} />
          ) : members.isError ? (
            <ErrorState error={members.error} />
          ) : (
            <>
              <p>{t('projects.membersCount', { count: members.data.length })}</p>
              {byRole.size === 0 ? null : (
                <ul className="flex flex-wrap gap-2 text-sm">
                  {[...byRole.entries()].map(([role, count]) => (
                    <li key={role} className="rounded-md border px-2 py-1">
                      {t(`projects.roles.${role}`)}: {count}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <h3 className="mt-2 text-sm font-medium">{t('projects.overview.locations')}</h3>
          {locations.isPending ? (
            <ListSkeleton rows={1} />
          ) : locations.isError ? (
            <ErrorState error={locations.error} />
          ) : locations.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('projects.overview.noLocations')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {locations.data.map((link) => (
                <li key={link.location.id}>
                  {link.location.name}{' '}
                  <span className="text-muted-foreground">· {t(`locations.types.${link.location.type}`)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('projects.overview.dailyReports')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <p>
            {project.dailyReportPolicy.required
              ? t('projects.overview.reportsRequired', { time: project.dailyReportPolicy.dueLocalTime })
              : t('projects.overview.reportsOptional')}
          </p>
          {project.access.canViewReports ? (
            missing.isPending ? (
              <ListSkeleton rows={1} />
            ) : missing.isError ? (
              <ErrorState error={missing.error} />
            ) : (
              <MissingSummary missing={missing.data} />
            )
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t('projects.overview.recentActivity')}</CardTitle>
        </CardHeader>
        <CardContent>
          {activity.isPending ? (
            <ListSkeleton rows={3} />
          ) : activity.isError ? (
            <ErrorState error={activity.error} />
          ) : (activity.data.pages[0]?.data.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{t('activity.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {(activity.data.pages[0]?.data ?? []).map((entry) => (
                <li key={entry.id}>
                  <span>{activityText(entry.type, entry.summaryParams)}</span>{' '}
                  <time dateTime={entry.occurredAt} className="text-xs text-muted-foreground">
                    {dateTime(entry.occurredAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MissingSummary({ missing }: { readonly missing: MissingReports }) {
  const t = useTranslations();
  const { date } = useDateFormat();
  if (!missing.reporting) {
    return <p className="text-muted-foreground">{t('reports.missing.notReporting')}</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="missing-reports">
      {missing.missing.length === 0 ? (
        <p>{t('reports.missing.none')}</p>
      ) : (
        <>
          <p className="font-medium text-warning">{t('reports.missing.count', { count: missing.missing.length })}</p>
          <ul className="flex flex-col gap-1">
            {missing.missing.map((entry) => (
              <li key={`${entry.date}:${entry.employee.id}`}>
                {date(entry.date)} · {entry.employee.fullName}
              </li>
            ))}
          </ul>
        </>
      )}
      {missing.pendingToday.length === 0 ? null : (
        <p className="text-muted-foreground">
          {t('reports.missing.pendingToday', {
            count: missing.pendingToday.length,
            time: missing.policy.dueLocalTime,
          })}
        </p>
      )}
    </div>
  );
}

// ---- Team ----

export function TeamTab({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const { date } = useDateFormat();
  const refresh = useProjectRefresh(project.id);
  const members = useProjectMembers(project.id);
  const manage = project.access.canAssignMembers && project.status !== 'ARCHIVED';
  const roleOptions = PROJECT_ROLES.filter((role) => project.access.canAssignManagers || !MANAGER_ROLES.includes(role));
  const [picked, setPicked] = useState<PickedEmployee | null>(null);
  const [role, setRole] = useState<ProjectRole>('DEVELOPER');

  const add = useMutation({
    mutationFn: (employeeId: string) =>
      request(() =>
        api.POST('/api/v1/projects/{id}/members', {
          params: { path: { id: project.id } },
          body: { employeeId, projectRole: role },
        }),
      ),
    onSuccess: async () => {
      setPicked(null);
      await refresh.invalidate();
    },
  });
  const change = useMutation({
    mutationFn: (input: { employeeId: string; projectRole: ProjectRole }) =>
      request(() =>
        api.PATCH('/api/v1/projects/{id}/members/{employeeId}', {
          params: { path: { id: project.id, employeeId: input.employeeId } },
          body: { projectRole: input.projectRole },
        }),
      ),
    onSuccess: refresh.invalidate,
  });
  const remove = useMutation({
    mutationFn: (employeeId: string) =>
      requestEmpty(() =>
        api.DELETE('/api/v1/projects/{id}/members/{employeeId}', {
          params: { path: { id: project.id, employeeId } },
        }),
      ),
    onSuccess: refresh.invalidate,
  });

  const onAdd = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (picked !== null) {
      add.mutate(picked.id);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle>{t('projects.team.title')}</CardTitle>
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
            <EmptyState message={t('projects.team.empty')} />
          ) : (
            <ul className="flex flex-col divide-y" data-testid="project-members">
              {members.data.map((member) => {
                const inactive = member.memberStatus === 'DISABLED' || member.employmentStatus === 'TERMINATED';
                const editable =
                  manage && (project.access.canAssignManagers || !MANAGER_ROLES.includes(member.projectRole));
                return (
                  <li
                    key={member.employeeId}
                    className="flex min-h-14 flex-wrap items-center justify-between gap-3 py-2"
                  >
                    <span className="flex min-w-0 flex-col">
                      <Link href={`/people/${member.employeeId}`} className="underline-offset-4 hover:underline">
                        {inactive ? t('projects.inactivePerson', { name: member.fullName }) : member.fullName}
                      </Link>
                      <span className="text-xs text-muted-foreground">
                        {member.employeeNumber}
                        {member.jobTitle === null ? '' : ` · ${member.jobTitle}`} ·{' '}
                        {t('projects.team.since', { date: date(member.startDate) })}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      {editable ? (
                        <>
                          <Label htmlFor={`role-${member.employeeId}`} className="sr-only">
                            {t('projects.team.roleFor', { name: member.fullName })}
                          </Label>
                          <NativeSelect
                            id={`role-${member.employeeId}`}
                            className="w-44"
                            value={member.projectRole}
                            disabled={change.isPending}
                            onChange={(event) => {
                              const next = roleOptions.find((value) => value === event.target.value);
                              if (next !== undefined) {
                                change.mutate({ employeeId: member.employeeId, projectRole: next });
                              }
                            }}
                          >
                            {roleOptions.map((value) => (
                              <option key={value} value={value}>
                                {t(`projects.roles.${value}`)}
                              </option>
                            ))}
                          </NativeSelect>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('projects.team.remove', { name: member.fullName })}
                            disabled={remove.isPending}
                            onClick={() => {
                              if (window.confirm(t('projects.team.confirmRemove', { name: member.fullName }))) {
                                remove.mutate(member.employeeId);
                              }
                            }}
                          >
                            <XIcon aria-hidden="true" />
                          </Button>
                        </>
                      ) : (
                        <span className="text-sm">{t(`projects.roles.${member.projectRole}`)}</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          <FormError error={change.error ?? remove.error} />
        </CardContent>
      </Card>
      {manage ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('projects.team.add')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={onAdd} className="flex flex-col gap-3">
              <FormError error={add.error} />
              <EmployeePicker label={t('projects.team.employee')} value={picked} onChange={setPicked} />
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="new-member-role">{t('projects.team.role')}</Label>
                <NativeSelect
                  id="new-member-role"
                  value={role}
                  onChange={(event) => {
                    const next = roleOptions.find((value) => value === event.target.value);
                    if (next !== undefined) {
                      setRole(next);
                    }
                  }}
                >
                  {roleOptions.map((value) => (
                    <option key={value} value={value}>
                      {t(`projects.roles.${value}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" className="self-end" disabled={picked === null || add.isPending}>
                {t('projects.team.add')}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---- Daily reports ----

export function ReportsTab({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const { date, dateTime } = useDateFormat();
  const [draft, setDraft] = useState({ from: '', to: '', status: '' });
  const [filters, setFilters] = useState<ReportFilters>({});
  const reports = useProjectReports(project.id, filters, project.access.canViewReports);
  const missing = useMissingReports(project.id, project.access.canViewReports);
  const rows = reports.data?.pages.flatMap((page) => page.data) ?? [];
  const canSubmit = project.access.canSubmitReports && project.status !== 'ARCHIVED' && project.status !== 'COMPLETED';

  return (
    <div className="flex flex-col gap-6">
      {canSubmit ? <SubmitReportForm project={project} /> : null}
      {project.access.canViewReports ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('reports.missing.title')}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {missing.isPending ? (
                <ListSkeleton rows={2} />
              ) : missing.isError ? (
                <ErrorState error={missing.error} />
              ) : (
                <MissingSummary missing={missing.data} />
              )}
            </CardContent>
          </Card>
          <section aria-labelledby="reports-list-title" className="flex flex-col gap-3">
            <h2 id="reports-list-title" className="text-lg font-semibold">
              {t('reports.listTitle')}
            </h2>
            <form
              role="search"
              aria-label={t('reports.filters')}
              className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                const status = REPORT_STATUSES.find((value) => value === draft.status);
                setFilters({
                  ...(draft.from === '' ? {} : { from: draft.from }),
                  ...(draft.to === '' ? {} : { to: draft.to }),
                  ...(status === undefined ? {} : { systemStatus: [status] }),
                });
              }}
            >
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reports-from">{t('reports.from')}</Label>
                <Input
                  id="reports-from"
                  type="date"
                  value={draft.from}
                  onChange={(event) => {
                    setDraft({ ...draft, from: event.target.value });
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reports-to">{t('reports.to')}</Label>
                <Input
                  id="reports-to"
                  type="date"
                  value={draft.to}
                  onChange={(event) => {
                    setDraft({ ...draft, to: event.target.value });
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reports-status">{t('reports.systemStatus')}</Label>
                <NativeSelect
                  id="reports-status"
                  value={draft.status}
                  onChange={(event) => {
                    setDraft({ ...draft, status: event.target.value });
                  }}
                >
                  <option value="">{t('common.all')}</option>
                  {REPORT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(`reports.statuses.${status}`)}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" variant="outline">
                {t('common.apply')}
              </Button>
            </form>
            {reports.isPending ? (
              <ListSkeleton rows={4} />
            ) : reports.isError ? (
              <ErrorState
                error={reports.error}
                onRetry={() => {
                  void reports.refetch();
                }}
              />
            ) : rows.length === 0 ? (
              <EmptyState message={t('reports.empty')} />
            ) : (
              <ul className="flex flex-col gap-2" data-testid="report-list">
                {rows.map((report) => (
                  <li key={report.id}>
                    <Link
                      href={`/daily-reports/${report.id}`}
                      className="flex flex-col gap-1 rounded-lg border p-3 hover:bg-accent sm:flex-row sm:items-center sm:justify-between"
                    >
                      <span className="flex flex-col">
                        <span className="font-medium">
                          {date(report.reportDate)} · {report.reporter.fullName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t('reports.submittedAt', { time: dateTime(report.submittedAt) })}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-2">
                        <ReportStatusBadge status={report.systemStatus} />
                        {report.followUpRequired ? (
                          <span className="rounded-md border px-2 py-0.5 text-xs">{t('reports.followUp')}</span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {reports.hasNextPage ? (
              <Button
                variant="outline"
                className="self-center"
                disabled={reports.isFetchingNextPage}
                onClick={() => {
                  void reports.fetchNextPage();
                }}
              >
                {reports.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
              </Button>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}

function SubmitReportForm({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const router = useRouter();
  const refresh = useProjectRefresh(project.id);
  const [draft, setDraft] = useState({
    reportDate: '',
    systemStatus: 'NORMAL',
    workPerformed: '',
    problems: '',
    operationalNotes: '',
    customerNotes: '',
    followUpRequired: false,
    followUpNotes: '',
  });
  const optional = (value: string) => (value.trim() === '' ? null : value.trim());
  const submit = useMutation({
    mutationFn: async () => {
      const systemStatus = REPORT_STATUSES.find((value) => value === draft.systemStatus) ?? 'NORMAL';
      return (
        await request(() =>
          api.POST('/api/v1/projects/{id}/daily-reports', {
            params: { path: { id: project.id } },
            body: {
              ...(draft.reportDate === '' ? {} : { reportDate: draft.reportDate }),
              systemStatus,
              workPerformed: draft.workPerformed.trim(),
              problems: optional(draft.problems),
              operationalNotes: optional(draft.operationalNotes),
              customerNotes: optional(draft.customerNotes),
              followUpRequired: draft.followUpRequired,
              followUpNotes: draft.followUpRequired ? optional(draft.followUpNotes) : null,
            },
          }),
        )
      ).data;
    },
    onSuccess: async (report) => {
      await refresh.invalidate();
      router.push(`/daily-reports/${report.id}?submitted=1`);
    },
  });
  const errors = fieldErrorsOf(submit.error);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('reports.submitTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <FormError error={submit.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label={t('reports.reportDate')}
              hint={t('reports.reportDateHint', { timeZone: project.effectiveTimeZone })}
              errorCode={errors.get('reportDate')}
              optional
            >
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={draft.reportDate}
                  onChange={(event) => {
                    setDraft({ ...draft, reportDate: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('reports.systemStatus')} errorCode={errors.get('systemStatus')}>
              {(control) => (
                <NativeSelect
                  {...control}
                  value={draft.systemStatus}
                  onChange={(event) => {
                    setDraft({ ...draft, systemStatus: event.target.value });
                  }}
                >
                  {REPORT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {t(`reports.statuses.${status}`)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          </div>
          <Field label={t('reports.workPerformed')} errorCode={errors.get('workPerformed')}>
            {(control) => (
              <Textarea
                {...control}
                required
                rows={4}
                value={draft.workPerformed}
                onChange={(event) => {
                  setDraft({ ...draft, workPerformed: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('reports.problems')} errorCode={errors.get('problems')} optional>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                value={draft.problems}
                onChange={(event) => {
                  setDraft({ ...draft, problems: event.target.value });
                }}
              />
            )}
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label={t('reports.operationalNotes')} errorCode={errors.get('operationalNotes')} optional>
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  value={draft.operationalNotes}
                  onChange={(event) => {
                    setDraft({ ...draft, operationalNotes: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('reports.customerNotes')} errorCode={errors.get('customerNotes')} optional>
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  value={draft.customerNotes}
                  onChange={(event) => {
                    setDraft({ ...draft, customerNotes: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.followUpRequired}
              onChange={(event) => {
                setDraft({ ...draft, followUpRequired: event.target.checked });
              }}
            />
            {t('reports.followUpRequired')}
          </label>
          {draft.followUpRequired ? (
            <Field label={t('reports.followUpNotes')} errorCode={errors.get('followUpNotes')} optional>
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  value={draft.followUpNotes}
                  onChange={(event) => {
                    setDraft({ ...draft, followUpNotes: event.target.value });
                  }}
                />
              )}
            </Field>
          ) : null}
          <Button type="submit" className="self-end" disabled={submit.isPending || draft.workPerformed.trim() === ''}>
            {submit.isPending ? t('common.saving') : t('reports.submit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---- Activity ----

export function ActivityTab({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const { dateTime } = useDateFormat();
  const activity = useProjectActivity(project.id);
  const activityText = useActivityText();
  const rows = activity.data?.pages.flatMap((page) => page.data) ?? [];
  if (activity.isPending) {
    return <ListSkeleton />;
  }
  if (activity.isError) {
    return (
      <ErrorState
        error={activity.error}
        onRetry={() => {
          void activity.refetch();
        }}
      />
    );
  }
  if (rows.length === 0) {
    return <EmptyState message={t('activity.empty')} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3 border-s ps-4" data-testid="project-activity">
        {rows.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-0.5">
            <span>{activityText(entry.type, entry.summaryParams)}</span>
            <span className="text-xs text-muted-foreground">
              <time dateTime={entry.occurredAt}>{dateTime(entry.occurredAt)}</time>
              {entry.actor?.fullName == null ? '' : ` · ${entry.actor.fullName}`}
            </span>
          </li>
        ))}
      </ol>
      {activity.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={activity.isFetchingNextPage}
          onClick={() => {
            void activity.fetchNextPage();
          }}
        >
          {activity.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

// ---- Settings ----

export function SettingsTab({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const refresh = useProjectRefresh(project.id);
  const archived = project.status === 'ARCHIVED';
  const [saved, setSaved] = useState(false);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {project.access.canManage && !archived ? (
        <>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t('projects.settings.details')}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {saved ? <StatusMessage>{t('projects.saved')}</StatusMessage> : null}
              <ProjectForm
                key={project.version}
                project={project}
                canAssignManagers={project.access.canAssignManagers}
                onDone={() => {
                  setSaved(true);
                }}
              />
            </CardContent>
          </Card>
          <StatusCard project={project} onSaved={refresh.saved} />
          <HealthCard project={project} onSaved={refresh.saved} />
          <PolicyCard project={project} onSaved={refresh.saved} />
          <LocationsCard project={project} />
        </>
      ) : null}
      {project.access.canArchive ? <ArchiveCard project={project} onSaved={refresh.saved} /> : null}
    </div>
  );
}

function StatusCard({
  project,
  onSaved,
}: {
  readonly project: Project;
  readonly onSaved: (p: Project) => Promise<void>;
}) {
  const t = useTranslations();
  const [status, setStatus] = useState<string>(project.status);
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const next = SETTABLE_STATUSES.find((value) => value === status);
      if (next === undefined) {
        throw new Error('invalid status');
      }
      return (
        await request(() =>
          api.PUT('/api/v1/projects/{id}/status', {
            params: { path: { id: project.id } },
            body: { status: next, reason: reason.trim() === '' ? null : reason.trim(), version: project.version },
          }),
        )
      ).data;
    },
    onSuccess: async (saved) => {
      setReason('');
      await onSaved(saved);
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.settings.status')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <FormError error={save.error} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-status">{t('projects.status')}</Label>
            <NativeSelect
              id="project-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            >
              {SETTABLE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`projects.statuses.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-status-reason">
              {t('projects.statusReason')}{' '}
              <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
            </Label>
            <Input
              id="project-status-reason"
              maxLength={1000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
          <Button type="submit" className="self-end" disabled={save.isPending || status === project.status}>
            {t('projects.settings.changeStatus')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function HealthCard({
  project,
  onSaved,
}: {
  readonly project: Project;
  readonly onSaved: (p: Project) => Promise<void>;
}) {
  const t = useTranslations();
  const [health, setHealth] = useState<string>(project.health);
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: async () => {
      const next = PROJECT_HEALTHS.find((value) => value === health);
      if (next === undefined) {
        throw new Error('invalid health');
      }
      return (
        await request(() =>
          api.PUT('/api/v1/projects/{id}/health', {
            params: { path: { id: project.id } },
            body: { health: next, note: note.trim(), version: project.version },
          }),
        )
      ).data;
    },
    onSuccess: async (saved) => {
      setNote('');
      await onSaved(saved);
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.settings.health')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <FormError error={save.error} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-health">{t('projects.health')}</Label>
            <NativeSelect
              id="project-health"
              value={health}
              onChange={(event) => {
                setHealth(event.target.value);
              }}
            >
              {PROJECT_HEALTHS.map((value) => (
                <option key={value} value={value}>
                  {t(`projects.healths.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Field label={t('projects.healthNote')} hint={t('projects.healthNoteHint')} errorCode={errors.get('note')}>
            {(control) => (
              <Textarea
                {...control}
                required
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" className="self-end" disabled={save.isPending || note.trim() === ''}>
            {t('projects.settings.changeHealth')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function PolicyCard({
  project,
  onSaved,
}: {
  readonly project: Project;
  readonly onSaved: (p: Project) => Promise<void>;
}) {
  const t = useTranslations();
  const policy = project.dailyReportPolicy;
  const [required, setRequired] = useState(policy.required);
  const [weekdays, setWeekdays] = useState<readonly number[]>(policy.weekdays);
  const [dueLocalTime, setDueLocalTime] = useState(policy.dueLocalTime);
  const [roles, setRoles] = useState<readonly ProjectRole[]>(policy.reporterRoles);
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.PATCH('/api/v1/projects/{id}', {
            params: { path: { id: project.id } },
            body: {
              dailyReportPolicy: {
                required,
                weekdays: [...weekdays].sort((a, b) => a - b),
                dueLocalTime,
                reporterRoles: [...roles],
              },
              version: project.version,
            },
          }),
        )
      ).data,
    onSuccess: async (saved) => {
      setDone(true);
      await onSaved(saved);
    },
  });
  const toggle = <T,>(list: readonly T[], value: T) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.settings.policy')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setDone(false);
            save.mutate();
          }}
        >
          <FormError error={save.error} />
          {done ? <StatusMessage>{t('projects.saved')}</StatusMessage> : null}
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={required}
              onChange={(event) => {
                setRequired(event.target.checked);
              }}
            />
            {t('projects.settings.reportsRequired')}
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{t('projects.settings.weekdays')}</legend>
            <p className="text-xs text-muted-foreground">{t('projects.settings.weekdaysHint')}</p>
            <div className="flex flex-wrap gap-3">
              {WEEKDAYS.map((day) => (
                <label key={day} className="flex min-h-11 items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={weekdays.includes(day)}
                    onChange={() => {
                      setWeekdays(toggle(weekdays, day));
                    }}
                  />
                  {t(`organization.weekdays.${String(day) as '1'}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-due">{t('projects.settings.dueTime')}</Label>
            <Input
              id="policy-due"
              type="time"
              value={dueLocalTime}
              onChange={(event) => {
                setDueLocalTime(event.target.value);
              }}
            />
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{t('projects.settings.reporterRoles')}</legend>
            <div className="flex flex-wrap gap-3">
              {PROJECT_ROLES.map((role) => (
                <label key={role} className="flex min-h-11 items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={() => {
                      setRoles(toggle(roles, role));
                    }}
                  />
                  {t(`projects.roles.${role}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <Button type="submit" className="self-end" disabled={save.isPending || roles.length === 0}>
            {t('common.save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function LocationsCard({ project }: { readonly project: Project }) {
  const t = useTranslations();
  const refresh = useProjectRefresh(project.id);
  const linked = useProjectLocations(project.id);
  const available = useWorkLocations();
  const [choice, setChoice] = useState('');
  const link = useMutation({
    mutationFn: (workLocationId: string) =>
      request(() =>
        api.POST('/api/v1/projects/{id}/locations', {
          params: { path: { id: project.id } },
          body: { workLocationId },
        }),
      ),
    onSuccess: async () => {
      setChoice('');
      await refresh.invalidate();
    },
  });
  const unlink = useMutation({
    mutationFn: (locationId: string) =>
      requestEmpty(() =>
        api.DELETE('/api/v1/projects/{id}/locations/{locationId}', {
          params: { path: { id: project.id, locationId } },
        }),
      ),
    onSuccess: refresh.invalidate,
  });
  const linkedIds = new Set((linked.data ?? []).map((item) => item.location.id));
  const options = (available.data ?? []).filter((location) => !linkedIds.has(location.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('projects.settings.locations')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {linked.isPending ? (
          <ListSkeleton rows={2} />
        ) : linked.isError ? (
          <ErrorState error={linked.error} />
        ) : linked.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('projects.overview.noLocations')}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {linked.data.map((item) => (
              <li key={item.location.id} className="flex min-h-12 items-center justify-between gap-2">
                <span>{item.location.name}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('projects.settings.unlink', { name: item.location.name })}
                  disabled={unlink.isPending}
                  onClick={() => {
                    unlink.mutate(item.location.id);
                  }}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <FormError error={link.error ?? unlink.error} />
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (choice !== '') {
              link.mutate(choice);
            }
          }}
        >
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="link-location">{t('projects.settings.linkLocation')}</Label>
            <NativeSelect
              id="link-location"
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value);
              }}
            >
              <option value="">{t('projects.settings.chooseLocation')}</option>
              {options.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline" disabled={choice === '' || link.isPending}>
            {t('projects.settings.link')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ArchiveCard({
  project,
  onSaved,
}: {
  readonly project: Project;
  readonly onSaved: (p: Project) => Promise<void>;
}) {
  const t = useTranslations();
  const archived = project.status === 'ARCHIVED';
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: async () =>
      archived
        ? (
            await request(() =>
              api.POST('/api/v1/projects/{id}/restore', {
                params: { path: { id: project.id } },
                body: { version: project.version },
              }),
            )
          ).data
        : (
            await request(() =>
              api.POST('/api/v1/projects/{id}/archive', {
                params: { path: { id: project.id } },
                body: { reason: reason.trim() === '' ? null : reason.trim(), version: project.version },
              }),
            )
          ).data,
    onSuccess: onSaved,
  });
  const archivable = ['PLANNING', 'ON_HOLD', 'COMPLETED'].includes(project.status);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{archived ? t('projects.settings.restore') : t('projects.settings.archive')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <FormError error={save.error} />
        <p className="text-muted-foreground">
          {archived
            ? t('projects.settings.restoreHint')
            : archivable
              ? t('projects.settings.archiveHint')
              : t('projects.settings.archiveBlocked')}
        </p>
        {archived ? null : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="archive-reason">
              {t('projects.settings.archiveReason')}{' '}
              <span className="font-normal text-muted-foreground">({t('common.optional')})</span>
            </Label>
            <Input
              id="archive-reason"
              maxLength={1000}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </div>
        )}
        <Button
          variant={archived ? 'outline' : 'destructive'}
          className="self-end"
          disabled={save.isPending || (!archived && !archivable)}
          onClick={() => {
            if (archived || window.confirm(t('projects.settings.confirmArchive', { name: project.name }))) {
              save.mutate();
            }
          }}
        >
          {archived ? t('projects.settings.restore') : t('projects.settings.archive')}
        </Button>
      </CardContent>
    </Card>
  );
}
