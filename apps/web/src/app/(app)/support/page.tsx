'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { LinkedFilterNotice, WithLinkParams } from '../../../components/linked-filter';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { TicketList } from '../../../components/support';
import { useDateFormat } from '../../../lib/format';
import { csvOf, instantOf, oneOf, uuidOf } from '../../../lib/link-params';
import { useProjects } from '../../../lib/projects';
import { useCan, useSession } from '../../../lib/session';
import {
  SLA_STATES,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_SORTS,
  TICKET_STATUSES,
  TICKET_VIEWS,
  useTickets,
} from '../../../lib/support';
import type { TicketQuery, TicketStatus as TicketStatusKey, TicketView } from '../../../lib/support';

/**
 * Views offered to the member (UX only; the API scopes every list). Support staff get the work
 * queues; reporters get their own tickets and the ones they watch. No per-person performance figures.
 */
function useTicketViews(): { readonly views: readonly TicketView[]; readonly fallback: TicketView } {
  const me = useSession();
  const can = useCan();
  const beyondSelf = me.permissions.some(
    (grant) => grant.key === 'support.view' && grant.scopes.some((scope) => scope !== 'SELF'),
  );
  if (!beyondSelf) {
    return { views: ['reported_by_me', 'watching'], fallback: 'reported_by_me' };
  }
  const views = TICKET_VIEWS.filter((view) => {
    if (view === 'assigned_to_me') {
      return can('support.resolve') || can('support.assign');
    }
    if (view === 'untriaged' || view === 'unassigned') {
      return can('support.triage') || can('support.assign');
    }
    return true;
  });
  return { views, fallback: 'open' };
}

/** Filters a dashboard deep link carries; the form shows what it can, the rest is listed in a notice. */
function initialParams(params: URLSearchParams, fallback: TicketView) {
  const status = csvOf(params.get('status'), TICKET_STATUSES);
  const slaState = csvOf(params.get('slaState'), SLA_STATES);
  const assigneeMemberId = uuidOf(params.get('assigneeMemberId'));
  const reporterMemberId = uuidOf(params.get('reporterMemberId'));
  const resolvedFrom = instantOf(params.get('resolvedFrom'));
  const resolvedTo = instantOf(params.get('resolvedTo'));
  const hidden: Omit<TicketQuery, 'view'> = {
    ...(status !== undefined && status.length > 1 ? { status: status.join(',') } : {}),
    ...(slaState !== undefined && slaState.length > 1 ? { slaState: slaState.join(',') } : {}),
    ...(assigneeMemberId === undefined ? {} : { assigneeMemberId }),
    ...(reporterMemberId === undefined ? {} : { reporterMemberId }),
    ...(resolvedFrom === undefined ? {} : { resolvedFrom }),
    ...(resolvedTo === undefined ? {} : { resolvedTo }),
  };
  return {
    view: oneOf(params.get('view'), TICKET_VIEWS) ?? fallback,
    projectId: uuidOf(params.get('projectId')) ?? '',
    status: status?.length === 1 ? (status[0] ?? '') : '',
    slaState: slaState?.length === 1 ? (slaState[0] ?? '') : '',
    hidden,
  };
}

export default function SupportPage() {
  const t = useTranslations();
  const can = useCan();
  if (!can('support.view') && !can('support.create')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('support.title')}
        description={t('support.description')}
        actions={
          can('support.create') ? (
            <Button asChild>
              <Link href="/support/new">
                <PlusIcon aria-hidden="true" />
                {t('support.new')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      {can('support.view') ? (
        <WithLinkParams fallback={<ListSkeleton rows={6} />}>
          {(params) => <TicketQueue params={params} />}
        </WithLinkParams>
      ) : (
        <EmptyState message={t('support.emptyReported')} />
      )}
    </>
  );
}

const EMPTY_DRAFT = { q: '', status: '', severity: '', priority: '', slaState: '', sort: 'createdAt:desc' };

function TicketQueue({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations();
  const can = useCan();
  const offered = useTicketViews();
  const [initial] = useState(() => initialParams(params, offered.fallback));
  // A linked view the selector does not offer (e.g. "open" for a reporter) is still listed so the count matches.
  const views = offered.views.includes(initial.view) ? offered.views : [...offered.views, initial.view];
  const [view, setView] = useState<TicketView>(initial.view);
  const [draft, setDraft] = useState({
    ...EMPTY_DRAFT,
    projectId: initial.projectId,
    status: initial.status,
    slaState: initial.slaState,
  });
  const [hidden, setHidden] = useState(initial.hidden);
  const [filters, setFilters] = useState<Omit<TicketQuery, 'view'>>(() => ({
    ...(initial.projectId === '' ? {} : { projectId: initial.projectId }),
    ...(initial.status === '' ? {} : { status: initial.status }),
    ...(initial.slaState === '' ? {} : { slaState: initial.slaState }),
  }));
  const { dateTime } = useDateFormat();
  const hiddenParts = [
    hidden.status === undefined
      ? null
      : hidden.status
          .split(',')
          .map((value) => t(`support.statuses.${value as TicketStatusKey}`))
          .join(', '),
    hidden.slaState === undefined
      ? null
      : hidden.slaState
          .split(',')
          .map((value) => t(`support.slaStates.${value as (typeof SLA_STATES)[number]}`))
          .join(', '),
    hidden.assigneeMemberId === undefined ? null : t('support.linked.assignedToMe'),
    hidden.reporterMemberId === undefined ? null : t('support.linked.reportedByMe'),
    hidden.resolvedFrom === undefined
      ? null
      : t('support.linked.resolvedSince', { date: dateTime(hidden.resolvedFrom) }),
  ].filter((part): part is string => part !== null);
  const readsProjects = can('project.view');
  const projects = useProjects({}, readsProjects);
  const query: TicketQuery = { view, ...hidden, ...filters };
  const tickets = useTickets(query);
  const rows = tickets.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = Object.keys(filters).some((key) => key !== 'sort') || hiddenParts.length > 0;

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const status = TICKET_STATUSES.find((value) => value === draft.status);
    const severity = TICKET_SEVERITIES.find((value) => value === draft.severity);
    const priority = TICKET_PRIORITIES.find((value) => value === draft.priority);
    const slaState = SLA_STATES.find((value) => value === draft.slaState);
    const sort = TICKET_SORTS.find((value) => value === draft.sort);
    setFilters({
      ...(draft.q.trim() === '' ? {} : { q: draft.q.trim() }),
      ...(status === undefined ? {} : { status }),
      ...(severity === undefined ? {} : { severity }),
      ...(priority === undefined ? {} : { priority }),
      ...(slaState === undefined ? {} : { slaState }),
      ...(draft.projectId === '' ? {} : { projectId: draft.projectId }),
      ...(sort === undefined || sort === 'createdAt:desc' ? {} : { sort }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 sm:max-w-xs">
        <Label htmlFor="support-view">{t('support.view')}</Label>
        <NativeSelect
          id="support-view"
          value={view}
          onChange={(event) => {
            const next = views.find((value) => value === event.target.value);
            if (next !== undefined) {
              setView(next);
            }
          }}
        >
          {views.map((value) => (
            <option key={value} value={value}>
              {t(`support.views.${value}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <form
        onSubmit={apply}
        role="search"
        aria-label={t('support.filters')}
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="support-q">{t('support.search')}</Label>
          <Input
            id="support-q"
            type="search"
            maxLength={200}
            placeholder={t('support.searchPlaceholder')}
            value={draft.q}
            onChange={(event) => {
              setDraft({ ...draft, q: event.target.value });
            }}
          />
        </div>
        <FilterSelect
          id="support-status"
          label={t('support.status')}
          value={draft.status}
          options={TICKET_STATUSES.map((value) => [value, t(`support.statuses.${value}`)] as const)}
          onChange={(value) => {
            setDraft({ ...draft, status: value });
          }}
        />
        <FilterSelect
          id="support-severity"
          label={t('support.severity')}
          value={draft.severity}
          options={TICKET_SEVERITIES.map((value) => [value, t(`support.severities.${value}`)] as const)}
          onChange={(value) => {
            setDraft({ ...draft, severity: value });
          }}
        />
        <FilterSelect
          id="support-priority"
          label={t('support.priority')}
          value={draft.priority}
          options={TICKET_PRIORITIES.map((value) => [value, t(`support.priorities.${value}`)] as const)}
          onChange={(value) => {
            setDraft({ ...draft, priority: value });
          }}
        />
        <FilterSelect
          id="support-sla"
          label={t('support.sla')}
          value={draft.slaState}
          options={SLA_STATES.map((value) => [value, t(`support.slaStates.${value}`)] as const)}
          onChange={(value) => {
            setDraft({ ...draft, slaState: value });
          }}
        />
        {readsProjects ? (
          <FilterSelect
            id="support-project"
            label={t('support.project')}
            value={draft.projectId}
            options={(projects.data?.pages.flatMap((page) => page.data) ?? []).map(
              (project) => [project.id, `${project.code} · ${project.name}`] as const,
            )}
            onChange={(value) => {
              setDraft({ ...draft, projectId: value });
            }}
          />
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="support-sort">{t('support.sort')}</Label>
          <NativeSelect
            id="support-sort"
            value={draft.sort}
            onChange={(event) => {
              setDraft({ ...draft, sort: event.target.value });
            }}
          >
            {TICKET_SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {t(`support.sorts.${sort.replace(':', '_') as 'createdAt_desc'}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline" className="lg:col-start-4">
          {t('common.apply')}
        </Button>
      </form>
      {hiddenParts.length === 0 ? null : (
        <LinkedFilterNotice
          description={hiddenParts.join(' · ')}
          onClear={() => {
            setHidden({});
          }}
        />
      )}

      {tickets.isPending ? (
        <ListSkeleton />
      ) : tickets.isError ? (
        <ErrorState
          error={tickets.error}
          onRetry={() => {
            void tickets.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          message={
            filtered
              ? t('support.emptyFiltered')
              : view === 'reported_by_me'
                ? t('support.emptyReported')
                : t('support.empty')
          }
        />
      ) : (
        <>
          <TicketList tickets={rows} label={t(`support.views.${view}`)} />
          {tickets.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={tickets.isFetchingNextPage}
              onClick={() => {
                void tickets.fetchNextPage();
              }}
            >
              {tickets.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('common');
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">{t('all')}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
