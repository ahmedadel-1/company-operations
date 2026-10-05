'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { LinkedFilterNotice, WithLinkParams } from '../../../components/linked-filter';
import { ProjectForm, ProjectHealthBadge, ProjectStatusBadge, usePersonLabel } from '../../../components/projects';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { useDateFormat } from '../../../lib/format';
import { PROJECT_HEALTHS, PROJECT_SORTS, PROJECT_STATUSES, useCustomers, useProjects } from '../../../lib/projects';
import type { ProjectFilters, ProjectSort } from '../../../lib/projects';
import { csvOf } from '../../../lib/link-params';
import { useCan, useCanOrgWide } from '../../../lib/session';

export default function ProjectsPage() {
  const t = useTranslations();
  const can = useCan();
  const orgWide = useCanOrgWide();
  if (!can('project.view')) {
    return <Forbidden />;
  }
  const createsProjects = orgWide('project.create');
  return (
    <>
      <PageHeader title={t('projects.title')} actions={createsProjects ? <CreateProjectButton /> : undefined} />
      <WithLinkParams fallback={<ListSkeleton rows={6} />}>
        {(params) => <ProjectList params={params} />}
      </WithLinkParams>
    </>
  );
}

function ProjectList({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations();
  const can = useCan();
  const orgWide = useCanOrgWide();
  const personLabel = usePersonLabel();
  const { date } = useDateFormat();
  const readsCustomers = can('project.create') || can('project.manage') || orgWide('project.view');
  const customers = useCustomers({ enabled: readsCustomers });
  const [initial] = useState(() => ({
    status: csvOf(params.get('status'), PROJECT_STATUSES),
    health: csvOf(params.get('health'), PROJECT_HEALTHS),
  }));
  const [draft, setDraft] = useState({
    q: '',
    status: initial.status?.length === 1 ? (initial.status[0] ?? '') : '',
    health: initial.health?.length === 1 ? (initial.health[0] ?? '') : '',
    customerId: '',
    scope: 'all',
    sort: 'updatedAt:desc',
    includeArchived: false,
  });
  const [filters, setFilters] = useState<ProjectFilters>(() => ({
    ...(initial.status === undefined ? {} : { status: initial.status }),
    ...(initial.health === undefined ? {} : { health: initial.health }),
    ...(initial.status?.includes('ARCHIVED') === true ? { includeArchived: true } : {}),
  }));
  const linkedStatuses = initial.status !== undefined && initial.status.length > 1;
  const projects = useProjects(filters);
  const rows = projects.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = Object.keys(filters).some((key) => key !== 'sort');

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const status = PROJECT_STATUSES.find((value) => value === draft.status);
    const health = PROJECT_HEALTHS.find((value) => value === draft.health);
    const sort = PROJECT_SORTS.find((value) => value === draft.sort);
    setFilters({
      ...(draft.q.trim() === '' ? {} : { q: draft.q.trim() }),
      ...(status === undefined ? {} : { status: [status] }),
      ...(health === undefined ? {} : { health: [health] }),
      ...(draft.customerId === '' ? {} : { customerId: draft.customerId }),
      ...(draft.scope === 'mine' ? { scope: 'mine' as const } : {}),
      ...(draft.includeArchived || status === 'ARCHIVED' ? { includeArchived: true } : {}),
      ...(sort === undefined || sort === 'updatedAt:desc' ? {} : { sort }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={apply}
        role="search"
        aria-label={t('projects.filters')}
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="projects-q">{t('projects.search')}</Label>
          <Input
            id="projects-q"
            type="search"
            placeholder={t('projects.searchPlaceholder')}
            value={draft.q}
            onChange={(event) => {
              setDraft({ ...draft, q: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="projects-status">{t('projects.status')}</Label>
          <NativeSelect
            id="projects-status"
            value={draft.status}
            onChange={(event) => {
              setDraft({ ...draft, status: event.target.value });
            }}
          >
            <option value="">{t('common.all')}</option>
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`projects.statuses.${status}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="projects-health">{t('projects.health')}</Label>
          <NativeSelect
            id="projects-health"
            value={draft.health}
            onChange={(event) => {
              setDraft({ ...draft, health: event.target.value });
            }}
          >
            <option value="">{t('common.all')}</option>
            {PROJECT_HEALTHS.map((health) => (
              <option key={health} value={health}>
                {t(`projects.healths.${health}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {readsCustomers ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="projects-customer">{t('projects.customer')}</Label>
            <NativeSelect
              id="projects-customer"
              value={draft.customerId}
              onChange={(event) => {
                setDraft({ ...draft, customerId: event.target.value });
              }}
            >
              <option value="">{t('common.all')}</option>
              {(customers.data?.pages.flatMap((page) => page.data) ?? []).map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="projects-scope">{t('projects.scope')}</Label>
          <NativeSelect
            id="projects-scope"
            value={draft.scope}
            onChange={(event) => {
              setDraft({ ...draft, scope: event.target.value });
            }}
          >
            <option value="all">{t('projects.scopeAll')}</option>
            <option value="mine">{t('projects.scopeMine')}</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="projects-sort">{t('projects.sort')}</Label>
          <NativeSelect
            id="projects-sort"
            value={draft.sort}
            onChange={(event) => {
              setDraft({ ...draft, sort: event.target.value });
            }}
          >
            {PROJECT_SORTS.map((sort: ProjectSort) => (
              <option key={sort} value={sort}>
                {t(`projects.sorts.${sort.replace(':', '_') as 'updatedAt_desc'}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.includeArchived}
            onChange={(event) => {
              setDraft({ ...draft, includeArchived: event.target.checked });
            }}
          />
          {t('projects.includeArchived')}
        </label>
        <Button type="submit" variant="outline" className="lg:col-start-4">
          {t('common.apply')}
        </Button>
      </form>
      {linkedStatuses && filters.status === initial.status ? (
        <LinkedFilterNotice
          description={(initial.status ?? []).map((status) => t(`projects.statuses.${status}`)).join(', ')}
          onClear={() => {
            const next = { ...filters };
            delete next.status;
            setFilters(next);
          }}
        />
      ) : null}

      {projects.isPending ? (
        <ListSkeleton />
      ) : projects.isError ? (
        <ErrorState
          error={projects.error}
          onRetry={() => {
            void projects.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          message={
            filtered
              ? t('projects.emptyFiltered')
              : filters.scope === 'mine'
                ? t('projects.emptyMine')
                : t('projects.empty')
          }
        />
      ) : (
        <>
          <Card className="hidden md:block">
            <Table>
              <thead>
                <TableRow>
                  <TableHead>{t('projects.name')}</TableHead>
                  <TableHead>{t('projects.customer')}</TableHead>
                  <TableHead>{t('projects.status')}</TableHead>
                  <TableHead>{t('projects.health')}</TableHead>
                  <TableHead>{t('projects.projectManager')}</TableHead>
                  <TableHead>{t('projects.targetEndDate')}</TableHead>
                  <TableHead>{t('projects.membersHeading')}</TableHead>
                </TableRow>
              </thead>
              <tbody>
                {rows.map((project) => (
                  <TableRow key={project.id} data-testid="project-row">
                    <TableCell className="font-medium">
                      <Link href={`/projects/${project.id}`} className="underline-offset-4 hover:underline">
                        {project.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{project.code}</span>
                    </TableCell>
                    <TableCell>{project.customer?.name ?? t('common.none')}</TableCell>
                    <TableCell>
                      <ProjectStatusBadge status={project.status} />
                    </TableCell>
                    <TableCell>
                      <ProjectHealthBadge health={project.health} />
                    </TableCell>
                    <TableCell>{personLabel(project.projectManager)}</TableCell>
                    <TableCell>
                      {project.targetEndDate === null ? t('common.none') : date(project.targetEndDate)}
                    </TableCell>
                    <TableCell>{project.memberCount}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="flex flex-col gap-3 md:hidden" aria-label={t('projects.title')}>
            {rows.map((project) => (
              <li key={project.id} data-testid="project-card">
                <Link
                  href={`/projects/${project.id}`}
                  className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-accent"
                >
                  <span className="font-medium">{project.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {project.code}
                    {project.customer === null ? '' : ` · ${project.customer.name}`}
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <ProjectStatusBadge status={project.status} />
                    <ProjectHealthBadge health={project.health} />
                  </span>
                  <span className="text-sm">
                    {t('projects.projectManager')}: {personLabel(project.projectManager)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {projects.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={projects.isFetchingNextPage}
              onClick={() => {
                void projects.fetchNextPage();
              }}
            >
              {projects.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

function CreateProjectButton() {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        <PlusIcon aria-hidden="true" />
        {t('projects.new')}
      </Button>
      <DialogContent title={t('projects.new')} closeLabel={t('common.close')}>
        <ProjectForm
          canAssignManagers
          onDone={(project) => {
            setOpen(false);
            router.push(`/projects/${project.id}`);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
