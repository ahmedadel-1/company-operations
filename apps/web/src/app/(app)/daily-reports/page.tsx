'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { ProjectStatusBadge } from '../../../components/projects';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { useProjects } from '../../../lib/projects';
import { useCan, useCanOrgWide } from '../../../lib/session';

/**
 * Entry point for daily reports: the projects where the member reports or reads reports. Members
 * with organization-wide report access see every running project; everyone else their own.
 */
export default function DailyReportsPage() {
  const t = useTranslations();
  const can = useCan();
  const orgWide = useCanOrgWide();
  const allowed = can('daily_report.submit') || can('daily_report.view');
  const projects = useProjects({
    status: ['ACTIVE', 'MAINTENANCE', 'ON_HOLD', 'PLANNING'],
    ...(orgWide('daily_report.view') ? {} : { scope: 'mine' as const }),
    sort: 'name:asc',
  });
  if (!allowed || !can('project.view')) {
    return <Forbidden />;
  }
  const rows = projects.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <PageHeader title={t('reports.hubTitle')} description={t('reports.hubDescription')} />
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
        <EmptyState message={t('reports.hubEmpty')} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((project) => (
            <li key={project.id}>
              <Link
                href={`/projects/${project.id}#reports`}
                className="flex min-h-24 flex-col gap-2 rounded-lg border p-4 hover:bg-accent"
              >
                <span className="font-medium">{project.name}</span>
                <span className="text-sm text-muted-foreground">
                  {project.code}
                  {project.customer === null ? '' : ` · ${project.customer.name}`}
                </span>
                <span>
                  <ProjectStatusBadge status={project.status} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
