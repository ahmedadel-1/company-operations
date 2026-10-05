'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, LinkIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import { useDateFormat } from '../lib/format';
import { githubKeys, useProjectGithub, useProjectJiraIssueSearch, useProjectPulls } from '../lib/github';
import type { GithubProjectRepository, GithubPull } from '../lib/github';
import type { Project } from '../lib/projects';
import { FormError, StatusMessage } from './form';
import { PullItem } from './github-shared';
import { EmptyState, ErrorState, ListSkeleton } from './states';

const HEALTH_TONE = {
  OK: 'success',
  SYNCING: 'warning',
  NOT_SYNCED: 'neutral',
  STALE: 'warning',
  FAILED: 'danger',
  UNAVAILABLE: 'danger',
  SUSPENDED: 'danger',
} as const satisfies Record<GithubProjectRepository['health'], 'success' | 'warning' | 'neutral' | 'danger'>;

type PullFilter = 'OPEN' | 'MERGED' | 'CLOSED';

/**
 * Project GitHub tab (Phase 5): mapped repositories with sync health, pull-request signals and the
 * pull requests from the local cache, with their Jira associations. GitHub stays the source of
 * truth; there is no code, diff or file content here, and nothing edits GitHub.
 */
export function GithubTab({ project }: { readonly project: Project }) {
  const t = useTranslations('github');
  const { dateTime } = useDateFormat();
  const overview = useProjectGithub(project.id);
  const [filter, setFilter] = useState<PullFilter>('OPEN');
  const [linking, setLinking] = useState<GithubPull | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const others = useProjectPulls(project.id, filter, filter !== 'OPEN' && overview.isSuccess);

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
  if (data.repositories.length === 0) {
    return (
      <EmptyState
        message={!data.configured ? t('project.notConfigured') : t('project.notMapped')}
        action={
          data.canManage && data.configured ? (
            <Button asChild variant="outline">
              <Link href="/admin/integrations/github">{t('project.manage')}</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }
  const stats = [
    [t('project.open'), data.signals.open],
    [t('signals.AWAITING_REVIEW'), data.signals.awaitingReview],
    [t('signals.CHANGES_REQUESTED'), data.signals.changesRequested],
    [t('signals.FAILING_CHECKS'), data.signals.failingChecks],
    [t('draft'), data.signals.draft],
    [t('project.staleRepositories'), data.signals.staleRepositories],
  ] as const;
  const pulls: readonly GithubPull[] =
    filter === 'OPEN' ? data.pulls : (others.data?.pages.flatMap((page) => page.data) ?? []);

  return (
    <div className="flex flex-col gap-4">
      {data.needsAttention ? (
        <p role="status" className="rounded-md border border-warning/40 p-3 text-sm text-warning">
          {t('project.attention')}
          {data.canManage ? (
            <>
              {' '}
              <Link href="/admin/integrations/github" className="underline underline-offset-4">
                {t('project.viewSync')}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{t('project.sourceOfTruth')}</p>
      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="github-signals">
        {stats.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 rounded-lg border p-4">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <Card>
        <CardHeader>
          <CardTitle>{t('project.repositories')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-sm" data-testid="github-project-repositories">
            {data.repositories.map((repo) => (
              <li
                key={repo.mappingId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                data-testid="github-project-repository"
              >
                <a
                  href={repo.htmlUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
                  aria-label={t('openRepository', { repository: repo.fullName })}
                >
                  <span dir="ltr">{repo.fullName}</span>
                  <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                </a>
                <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  {repo.private ? <Badge>{t('private')}</Badge> : null}
                  {repo.archived ? <Badge>{t('archived')}</Badge> : null}
                  <Badge tone={HEALTH_TONE[repo.health]}>{t(`health.${repo.health}`)}</Badge>
                  {t('project.openCount', { count: repo.openPullCount })}
                  {' · '}
                  {repo.lastSyncedAt === null
                    ? t('project.neverSynced')
                    : t('project.lastSynced', { date: dateTime(repo.lastSyncedAt) })}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <section aria-labelledby="project-github-pulls" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h2 id="project-github-pulls" className="text-lg font-semibold">
            {t('project.pulls')}
          </h2>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="github-pull-filter">{t('project.show')}</Label>
            <NativeSelect
              id="github-pull-filter"
              value={filter}
              onChange={(event) => {
                const next = (['OPEN', 'MERGED', 'CLOSED'] as const).find((value) => value === event.target.value);
                if (next !== undefined) {
                  setFilter(next);
                }
              }}
            >
              <option value="OPEN">{t('pullStates.OPEN')}</option>
              <option value="MERGED">{t('pullStates.MERGED')}</option>
              <option value="CLOSED">{t('pullStates.CLOSED')}</option>
            </NativeSelect>
          </div>
        </div>
        {status === null ? null : <StatusMessage>{status}</StatusMessage>}
        {filter !== 'OPEN' && others.isPending ? (
          <ListSkeleton rows={3} />
        ) : filter !== 'OPEN' && others.isError ? (
          <ErrorState error={others.error} />
        ) : pulls.length === 0 ? (
          <EmptyState message={t('project.noPulls')} />
        ) : (
          <ul className="flex flex-col gap-2" aria-labelledby="project-github-pulls" data-testid="github-project-pulls">
            {pulls.map((pull) => (
              <PullItem
                key={pull.id}
                pull={pull}
                projectId={project.id}
                canDecide={data.canLink}
                actions={
                  data.canLink ? (
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={t('project.linkIssueLabel', { number: pull.number })}
                        onClick={() => {
                          setLinking(pull);
                        }}
                      >
                        <LinkIcon aria-hidden="true" />
                        {t('project.linkIssue')}
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
        {filter !== 'OPEN' && others.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={others.isFetchingNextPage}
            onClick={() => {
              void others.fetchNextPage();
            }}
          >
            {t('loadMore')}
          </Button>
        ) : null}
      </section>
      <Dialog
        open={linking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLinking(null);
          }
        }}
      >
        {linking === null ? null : (
          <DialogContent title={t('project.linkTitle', { number: linking.number })} closeLabel={t('close')}>
            <LinkIssueDialog
              projectId={project.id}
              pull={linking}
              onDone={(key) => {
                setLinking(null);
                setStatus(t('project.linkedStatus', { key, number: linking.number }));
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function LinkIssueDialog({
  projectId,
  pull,
  onDone,
}: {
  readonly projectId: string;
  readonly pull: GithubPull;
  readonly onDone: (key: string) => void;
}) {
  const t = useTranslations('github');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const results = useProjectJiraIssueSearch(projectId, query, true);
  const linkedIds = new Set(pull.jiraLinks.filter((link) => link.state === 'CONFIRMED').map((link) => link.issue.id));
  const link = useMutation({
    mutationFn: (issue: { id: string; key: string }) =>
      request(() =>
        api.POST('/api/v1/projects/{id}/github/pulls/{pullId}/jira-links', {
          params: { path: { id: projectId, pullId: pull.id } },
          body: { issueId: issue.id },
        }),
      ).then(() => issue.key),
    onSuccess: async (key) => {
      await queryClient.invalidateQueries({ queryKey: githubKeys.all });
      onDone(key);
    },
  });
  return (
    <div className="flex flex-col gap-3">
      <form
        role="search"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <div className="flex min-w-48 flex-1 flex-col gap-1.5">
          <Label htmlFor="github-jira-search">{t('project.searchIssues')}</Label>
          <Input
            id="github-jira-search"
            value={draft}
            maxLength={100}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <Button type="submit" variant="outline">
          {t('search')}
        </Button>
      </form>
      <FormError error={link.error} />
      {results.isPending ? (
        <ListSkeleton rows={3} />
      ) : results.isError ? (
        <ErrorState error={results.error} />
      ) : results.data.length === 0 ? (
        <EmptyState message={t('project.noIssues')} />
      ) : (
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-label={t('project.issueResults')}>
          {results.data.map((issue) => (
            <li
              key={issue.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium">
                  {issue.key} · {issue.statusName}
                </span>
                <span className="break-words text-muted-foreground">{issue.summary}</span>
              </span>
              {linkedIds.has(issue.id) ? (
                <Badge>{t('project.alreadyLinked')}</Badge>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={link.isPending}
                  aria-label={t('project.linkIssueKey', { key: issue.key })}
                  onClick={() => {
                    link.mutate({ id: issue.id, key: issue.key });
                  }}
                >
                  {t('project.link')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
