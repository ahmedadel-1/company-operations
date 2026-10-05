'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Input, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import { projectKeys, useCustomers } from '../lib/projects';
import type { DailyReportStatus, Project, ProjectHealth, ProjectStatus } from '../lib/projects';
import { EmployeePicker } from './employee-picker';
import type { PickedEmployee } from './employee-picker';
import { Field, fieldErrorsOf, FormError } from './form';

export function ProjectStatusBadge({ status }: { readonly status: ProjectStatus }) {
  const t = useTranslations('projects.statuses');
  const tone =
    status === 'ACTIVE' || status === 'MAINTENANCE' ? 'success' : status === 'ON_HOLD' ? 'warning' : 'neutral';
  return <Badge tone={tone}>{t(status)}</Badge>;
}

export function ProjectHealthBadge({ health }: { readonly health: ProjectHealth }) {
  const t = useTranslations('projects.healths');
  const tone = health === 'HEALTHY' ? 'success' : health === 'NEEDS_ATTENTION' ? 'warning' : 'danger';
  return <Badge tone={tone}>{t(health)}</Badge>;
}

export function ReportStatusBadge({ status }: { readonly status: DailyReportStatus }) {
  const t = useTranslations('reports.statuses');
  const tone = status === 'NORMAL' ? 'success' : status === 'DEGRADED' ? 'warning' : 'danger';
  return <Badge tone={tone}>{t(status)}</Badge>;
}

interface PersonRef {
  readonly fullName: string;
  readonly memberStatus: 'INVITED' | 'ACTIVE' | 'DISABLED';
  readonly employmentStatus: 'ACTIVE' | 'ON_LEAVE' | 'SUSPENDED' | 'TERMINATED';
}

/** People stay visible in project history after they leave; inactive people are labelled as such. */
export function usePersonLabel(): (person: PersonRef | null) => string {
  const t = useTranslations();
  return (person) => {
    if (person === null) {
      return t('common.none');
    }
    return person.memberStatus === 'DISABLED' || person.employmentStatus === 'TERMINATED'
      ? t('projects.inactivePerson', { name: person.fullName })
      : person.fullName;
  };
}

const ACTIVITY_TYPES = [
  'project.created',
  'project.updated',
  'project.managers_changed',
  'project.status_changed',
  'project.health_changed',
  'project.archived',
  'project.restored',
  'project.member_added',
  'project.member_updated',
  'project.member_role_changed',
  'project.member_removed',
  'project.location_linked',
  'project.location_unlinked',
  'project.support_team_changed',
  'daily_report.submitted',
  'support.ticket_created',
  'support.ticket_resolved',
  'support.ticket_closed',
  'support.ticket_cancelled',
  'support.ticket_reopened',
  'jira.mapping_added',
  'jira.mapping_removed',
  'jira.issue_created_from_ticket',
  'github.repository_mapped',
  'github.repository_unmapped',
  'github.pr_merged',
] as const;
type ActivityType = (typeof ACTIVITY_TYPES)[number];

function isActivityType(value: string): value is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(value);
}

/** Localized timeline text from the stable `type` and `summaryParams` (never server-rendered prose). */
export function useActivityText(): (type: string, params: Record<string, unknown>) => string {
  const t = useTranslations('activity');
  const status = useTranslations('projects.statuses');
  const health = useTranslations('projects.healths');
  const role = useTranslations('projects.roles');
  const reportStatus = useTranslations('reports.statuses');
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  const label = <K extends string>(translate: (key: K) => string, keys: readonly K[], value: unknown) =>
    typeof value === 'string' && (keys as readonly string[]).includes(value) ? translate(value as K) : text(value);
  const statusOf = (value: unknown) => label(status, PROJECT_STATUS_KEYS, value);
  const healthOf = (value: unknown) => label(health, PROJECT_HEALTH_KEYS, value);
  const roleOf = (value: unknown) => label(role, PROJECT_ROLE_KEYS, value);
  return (type, params) => {
    if (!isActivityType(type)) {
      return t('generic');
    }
    switch (type) {
      case 'project.created':
        return t('project.created', { code: text(params.code), name: text(params.name) });
      case 'project.updated':
        return t('project.updated');
      case 'project.managers_changed':
        return t('project.managers_changed');
      case 'project.status_changed':
        return t('project.status_changed', { from: statusOf(params.from), to: statusOf(params.to) });
      case 'project.health_changed':
        return t('project.health_changed', { from: healthOf(params.from), to: healthOf(params.to) });
      case 'project.archived':
        return t('project.archived');
      case 'project.restored':
        return t('project.restored');
      case 'project.member_added':
        return t('project.member_added', { name: text(params.employeeName), role: roleOf(params.projectRole) });
      case 'project.member_updated':
        return t('project.member_updated', { name: text(params.employeeName) });
      case 'project.member_role_changed':
        return t('project.member_role_changed', {
          name: text(params.employeeName),
          from: roleOf(params.fromRole),
          to: roleOf(params.projectRole),
        });
      case 'project.member_removed':
        return t('project.member_removed', { name: text(params.employeeName) });
      case 'project.location_linked':
        return t('project.location_linked', { location: text(params.locationName) });
      case 'project.location_unlinked':
        return t('project.location_unlinked', { location: text(params.locationName) });
      case 'project.support_team_changed':
        return typeof params.teamName === 'string'
          ? t('project.support_team_changed', { team: params.teamName })
          : t('project.support_team_removed');
      case 'daily_report.submitted':
        return t('daily_report.submitted', {
          name: text(params.reporterName),
          date: text(params.reportDate),
          status: label(reportStatus, REPORT_STATUS_KEYS, params.systemStatus),
        });
      case 'support.ticket_created':
        return t('support.ticket_created', { ticket: text(params.ticketNumber) });
      case 'support.ticket_resolved':
        return t('support.ticket_resolved', { ticket: text(params.ticketNumber) });
      case 'support.ticket_closed':
        return t('support.ticket_closed', { ticket: text(params.ticketNumber) });
      case 'support.ticket_cancelled':
        return t('support.ticket_cancelled', { ticket: text(params.ticketNumber) });
      case 'support.ticket_reopened':
        return t('support.ticket_reopened', { ticket: text(params.ticketNumber) });
      case 'jira.mapping_added':
      case 'jira.mapping_removed':
        return t(type, { key: text(params.jiraProjectKey), name: text(params.jiraProjectName) });
      case 'jira.issue_created_from_ticket':
        return t('jira.issue_created_from_ticket', { issue: text(params.issueKey), ticket: text(params.ticketNumber) });
      case 'github.repository_mapped':
      case 'github.repository_unmapped':
        return t(type, { repository: text(params.repository) });
      case 'github.pr_merged':
        return t('github.pr_merged', {
          repository: text(params.repository),
          number: text(params.number),
          title: text(params.title),
        });
    }
  };
}

const PROJECT_STATUS_KEYS = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'MAINTENANCE', 'COMPLETED', 'ARCHIVED'] as const;
const PROJECT_HEALTH_KEYS = ['HEALTHY', 'NEEDS_ATTENTION', 'AT_RISK', 'CRITICAL'] as const;
const PROJECT_ROLE_KEYS = [
  'PROJECT_MANAGER',
  'TECHNICAL_MANAGER',
  'DEVELOPER',
  'SUPPORT',
  'FIELD',
  'QA',
  'OBSERVER',
] as const;
const REPORT_STATUS_KEYS = ['NORMAL', 'DEGRADED', 'ISSUE', 'CRITICAL'] as const;

/** Create (no `project`) or edit the details of a project. Managers can be changed only with org-wide rights. */
export function ProjectForm({
  project,
  canAssignManagers,
  onDone,
}: {
  readonly project?: Project;
  readonly canAssignManagers: boolean;
  readonly onDone: (project: Project) => void;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const customers = useCustomers();
  const [draft, setDraft] = useState({
    name: project?.name ?? '',
    code: project?.code ?? '',
    customerId: project?.customer?.id ?? '',
    description: project?.description ?? '',
    startDate: project?.startDate ?? '',
    targetEndDate: project?.targetEndDate ?? '',
  });
  const [manager, setManager] = useState<PickedEmployee | null>(
    project?.projectManager == null
      ? null
      : { id: project.projectManager.id, fullName: project.projectManager.fullName },
  );
  const [technical, setTechnical] = useState<PickedEmployee | null>(
    project?.technicalManager == null
      ? null
      : { id: project.technicalManager.id, fullName: project.technicalManager.fullName },
  );

  const save = useMutation({
    mutationFn: async () => {
      const details = {
        name: draft.name.trim(),
        customerId: draft.customerId === '' ? null : draft.customerId,
        description: draft.description.trim() === '' ? null : draft.description.trim(),
        startDate: draft.startDate === '' ? null : draft.startDate,
        targetEndDate: draft.targetEndDate === '' ? null : draft.targetEndDate,
        ...(canAssignManagers
          ? { projectManagerId: manager?.id ?? null, technicalManagerId: technical?.id ?? null }
          : {}),
      };
      if (project === undefined) {
        return (
          await request(() =>
            api.POST('/api/v1/projects', {
              body: { ...details, ...(draft.code.trim() === '' ? {} : { code: draft.code.trim() }) },
            }),
          )
        ).data;
      }
      return (
        await request(() =>
          api.PATCH('/api/v1/projects/{id}', {
            params: { path: { id: project.id } },
            body: {
              ...details,
              ...(draft.code.trim() === project.code ? {} : { code: draft.code.trim() }),
              version: project.version,
            },
          }),
        )
      ).data;
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(projectKeys.detail(saved.id), saved);
      await queryClient.invalidateQueries({ queryKey: projectKeys.all });
      onDone(saved);
    },
  });
  const errors = fieldErrorsOf(save.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  const customerOptions = customers.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <FormError error={save.error} />
      <Field label={t('projects.name')} errorCode={errors.get('name')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={200}
            value={draft.name}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('projects.code')} hint={t('projects.codeHint')} errorCode={errors.get('code')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={20}
            value={draft.code}
            onChange={(event) => {
              setDraft({ ...draft, code: event.target.value.toUpperCase() });
            }}
          />
        )}
      </Field>
      <Field label={t('projects.customer')} errorCode={errors.get('customerId')} optional>
        {(control) => (
          <NativeSelect
            {...control}
            value={draft.customerId}
            onChange={(event) => {
              setDraft({ ...draft, customerId: event.target.value });
            }}
          >
            <option value="">{t('projects.noCustomer')}</option>
            {customerOptions.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('projects.startDate')} errorCode={errors.get('startDate')} optional>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={draft.startDate}
              onChange={(event) => {
                setDraft({ ...draft, startDate: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label={t('projects.targetEndDate')} errorCode={errors.get('targetEndDate')} optional>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={draft.targetEndDate}
              onChange={(event) => {
                setDraft({ ...draft, targetEndDate: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <Field label={t('projects.description')} errorCode={errors.get('description')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
          />
        )}
      </Field>
      {canAssignManagers ? (
        <div className="grid gap-4 md:grid-cols-2">
          <EmployeePicker label={t('projects.projectManager')} value={manager} onChange={setManager} allowNone />
          <EmployeePicker label={t('projects.technicalManager')} value={technical} onChange={setTechnical} allowNone />
        </div>
      ) : null}
      <Button type="submit" className="self-end" disabled={save.isPending || draft.name.trim() === ''}>
        {save.isPending ? t('common.saving') : project === undefined ? t('common.create') : t('common.save')}
      </Button>
    </form>
  );
}
