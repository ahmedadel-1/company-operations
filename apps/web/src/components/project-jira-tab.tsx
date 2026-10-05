'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';

import { useDateFormat } from '../lib/format';
import { useProjectJira } from '../lib/jira';
import type { Project } from '../lib/projects';
import { EmptyState, ErrorState, ListSkeleton } from './states';
import { JiraIssueLink, JiraStatusBadge } from './ticket-jira-panel';

/**
 * Project Jira tab (Phase 4): mapped Jira projects, sync health and delivery signals derived from
 * the issue cache. Jira stays the source of truth; nothing here edits Jira work.
 */
export function JiraTab({ project }: { readonly project: Project }) {
  const t = useTranslations('jira');
  const { dateTime, date } = useDateFormat();
  const overview = useProjectJira(project.id);

  if (overview.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (overview.isError) {
    return (
      <ErrorState
        error={overview.error}
        onRetry={() => {
          void overview.refetch();
        }}
      />
    );
  }
  const data = overview.data;
  if (data.mappings.length === 0) {
    return (
      <EmptyState
        message={!data.configured ? t('project.notConfigured') : t('project.notMapped')}
        action={
          data.canManage && data.configured ? (
            <Button asChild variant="outline">
              <Link href="/admin/integrations/jira">{t('project.manage')}</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }
  const stats = [
    [t('project.open'), data.signals.open],
    [t('project.inProgress'), data.signals.byCategory.IN_PROGRESS],
    [t('project.blocked'), data.signals.blocked],
    [t('project.overdue'), data.signals.overdue],
    [t('project.done'), data.signals.byCategory.DONE],
    [t('project.linkedTickets'), data.signals.linkedTickets],
  ] as const;

  return (
    <div className="flex flex-col gap-4">
      {data.needsAttention ? (
        <p role="status" className="rounded-md border border-warning/40 p-3 text-sm text-warning">
          {data.connectionStatus === 'NEEDS_REAUTH' ? t('project.reauth') : t('project.attention')}
          {data.canManage ? (
            <>
              {' '}
              <Link href="/admin/integrations/jira/sync" className="underline underline-offset-4">
                {t('project.viewSync')}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{t('project.sourceOfTruth')}</p>
      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {stats.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 rounded-lg border p-4">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <Card>
        <CardHeader>
          <CardTitle>{t('project.mappings')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm">
            {data.mappings.map((mapping) => (
              <li key={mapping.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <span className="font-medium">
                  {mapping.jiraProject.key} · {mapping.jiraProject.name}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  {mapping.syncEnabled ? null : <Badge tone="warning">{t('admin.paused')}</Badge>}
                  <Badge
                    tone={
                      mapping.importState === 'FAILED'
                        ? 'danger'
                        : mapping.importState === 'COMPLETED'
                          ? 'success'
                          : 'neutral'
                    }
                  >
                    {t(`importStates.${mapping.importState}`)}
                  </Badge>
                  {mapping.lastReconciledAt === null
                    ? t('project.neverSynced')
                    : t('project.lastSynced', { date: dateTime(mapping.lastReconciledAt) })}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <section aria-labelledby="project-jira-recent" className="flex flex-col gap-3">
        <h2 id="project-jira-recent" className="text-lg font-semibold">
          {t('project.recent')}
        </h2>
        {data.recentIssues.length === 0 ? (
          <EmptyState message={t('project.noIssues')} />
        ) : (
          <ul className="flex flex-col gap-2" aria-labelledby="project-jira-recent">
            {data.recentIssues.map((issue) => (
              <li
                key={issue.id}
                className="flex flex-col gap-1 rounded-md border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <JiraIssueLink issue={issue} />
                    <span className="text-muted-foreground">{issue.issueType}</span>
                  </span>
                  <span className="break-words">{issue.summary}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <JiraStatusBadge issue={issue} />
                  {issue.assigneeDisplayName ?? t('unassigned')}
                  {issue.dueDate === null ? null : <span>{t('due', { date: date(issue.dueDate) })}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
