'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, PlugIcon, RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Label, NativeSelect } from '@company-ops/ui/components/input';

import { api, request, requestEmpty } from '../lib/api';
import { useDateFormat } from '../lib/format';
import {
  ACTIVE_GITHUB_RUN_STATUSES,
  GITHUB_DELIVERY_STATUSES,
  GITHUB_RUN_STATUSES,
  githubKeys,
  useGithubDeliveries,
  useGithubRepositories,
  useGithubRun,
  useGithubRuns,
} from '../lib/github';
import type {
  GithubDeliveryStatus,
  GithubInstallation,
  GithubIntegrationStatus,
  GithubRepository,
  GithubRun,
  GithubRunStatus,
} from '../lib/github';
import { useProjects } from '../lib/projects';
import { Field, fieldErrorsOf, FormError, StatusMessage } from './form';
import { useGithubErrorCode } from './github-shared';
import { EmptyState, ErrorState, ListSkeleton } from './states';

function useGithubInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: githubKeys.all });
}

/** Outcome of the installation round trip, from the setup/callback redirect's query string. */
export function GithubCallbackNotice({
  outcome,
  reason,
}: {
  readonly outcome: string | null;
  readonly reason: string | null;
}) {
  const t = useTranslations('github.admin');
  if (outcome === 'installed' || outcome === 'refreshed') {
    return <StatusMessage>{t(outcome === 'installed' ? 'installedNotice' : 'refreshedNotice')}</StatusMessage>;
  }
  if (outcome === 'requested') {
    return <StatusMessage>{t('requestedNotice')}</StatusMessage>;
  }
  if (outcome === 'error') {
    const key =
      reason === 'authorization_denied'
        ? 'authorizationDenied'
        : reason === 'github_installation_conflict'
          ? 'installationConflict'
          : reason === 'github_setup_invalid'
            ? 'setupInvalid'
            : 'installFailed';
    return (
      <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
        {t(key)}
      </p>
    );
  }
  return null;
}

const INSTALLATION_TONE = {
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  DELETED: 'danger',
  DISCONNECTED: 'neutral',
} as const satisfies Record<GithubInstallation['status'], 'success' | 'danger' | 'neutral'>;

export function InstallationsCard({ status }: { readonly status: GithubIntegrationStatus }) {
  const t = useTranslations('github');
  const install = useMutation({
    mutationFn: () => request(() => api.POST('/api/v1/integrations/github/install')),
    onSuccess: (result) => {
      window.location.assign(result.data.installUrl);
    },
  });
  if (!status.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.app')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t('admin.notConfigured')}</CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('admin.installations')}</CardTitle>
        {status.canInstall ? (
          <Button
            type="button"
            size="sm"
            disabled={install.isPending}
            onClick={() => {
              install.mutate();
            }}
          >
            <PlugIcon aria-hidden="true" />
            {t('admin.install')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <FormError error={install.error} />
        {status.installations.length === 0 ? (
          <p className="text-muted-foreground">{t('admin.noInstallations')}</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="github-installations">
            {status.installations.map((installation) => (
              <InstallationRow key={installation.id} installation={installation} />
            ))}
          </ul>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('admin.appSettings')}</summary>
          <dl className="mt-2 grid gap-1 break-all">
            {status.webhookUrl === null ? null : (
              <div>
                <dt className="inline font-medium">{t('admin.webhookUrl')}: </dt>
                <dd className="inline">{status.webhookUrl}</dd>
              </div>
            )}
            {status.setupUrl === null ? null : (
              <div>
                <dt className="inline font-medium">{t('admin.setupUrl')}: </dt>
                <dd className="inline">{status.setupUrl}</dd>
              </div>
            )}
            {status.callbackUrl === null ? null : (
              <div>
                <dt className="inline font-medium">{t('admin.callbackUrl')}: </dt>
                <dd className="inline">{status.callbackUrl}</dd>
              </div>
            )}
            <div>
              <dt className="inline font-medium">{t('admin.permissions')}: </dt>
              <dd className="inline">
                {Object.entries(status.requiredPermissions)
                  .map(([name, level]) => `${name}: ${level}`)
                  .join(', ')}
              </dd>
            </div>
            <div>
              <dt className="inline font-medium">{t('admin.events')}: </dt>
              <dd className="inline">{status.subscribedEvents.join(', ')}</dd>
            </div>
          </dl>
        </details>
      </CardContent>
    </Card>
  );
}

function InstallationRow({ installation }: { readonly installation: GithubInstallation }) {
  const t = useTranslations('github');
  const { dateTime } = useDateFormat();
  const errorText = useGithubErrorCode();
  const invalidate = useGithubInvalidate();
  const [confirm, setConfirm] = useState(false);
  const refresh = useMutation({
    mutationFn: () =>
      requestEmpty(() =>
        api.POST('/api/v1/integrations/github/installations/{id}/refresh', {
          params: { path: { id: installation.id } },
        }),
      ),
    onSuccess: invalidate,
  });
  const disconnect = useMutation({
    mutationFn: () =>
      request(() =>
        api.DELETE('/api/v1/integrations/github/installations/{id}', {
          params: { path: { id: installation.id }, query: { version: installation.version } },
        }),
      ),
    onSuccess: async () => {
      setConfirm(false);
      await invalidate();
    },
  });
  return (
    <li
      className="flex flex-col gap-2 rounded-md border p-3"
      data-testid="github-installation"
      data-status={installation.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium" dir="ltr">
          {installation.accountLogin}
        </span>
        <span className="flex flex-wrap gap-2">
          <Badge>{t(`accountTypes.${installation.accountType}`)}</Badge>
          <Badge tone={INSTALLATION_TONE[installation.status]}>
            {t(`installationStatuses.${installation.status}`)}
          </Badge>
        </span>
      </div>
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('admin.repositoryAccess')}</dt>
          <dd>
            {t(`selections.${installation.repositorySelection}`)} ·{' '}
            {t('admin.repositoryCount', { count: installation.repositoryCount })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('admin.boundAt')}</dt>
          <dd>
            {dateTime(installation.boundAt)}
            {installation.installedBy?.fullName == null ? '' : ` · ${installation.installedBy.fullName}`}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('admin.lastSynced')}</dt>
          <dd>{installation.lastSyncedAt === null ? t('admin.never') : dateTime(installation.lastSyncedAt)}</dd>
        </div>
        {installation.lastErrorCode === null ? null : (
          <div>
            <dt className="text-muted-foreground">{t('admin.lastError')}</dt>
            <dd className="text-destructive">{errorText(installation.lastErrorCode)}</dd>
          </div>
        )}
      </dl>
      {installation.status === 'SUSPENDED' ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-destructive">
          {t('admin.suspendedNotice')}
        </p>
      ) : installation.status === 'DELETED' ? (
        <p role="alert" className="rounded-md border border-destructive/40 p-2 text-destructive">
          {t('admin.deletedNotice')}
        </p>
      ) : null}
      {installation.missingPermissions.length === 0 ? null : (
        <p role="alert" className="rounded-md border border-warning/40 p-2 text-warning">
          {t('admin.missingPermissions', { permissions: installation.missingPermissions.join(', ') })}
        </p>
      )}
      <FormError error={refresh.error ?? disconnect.error} />
      <div className="flex flex-wrap gap-2">
        {installation.status === 'DELETED' ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refresh.isPending}
            onClick={() => {
              refresh.mutate();
            }}
          >
            <RefreshCwIcon aria-hidden="true" />
            {t('admin.refresh')}
          </Button>
        )}
        {installation.manageUrl === null ? null : (
          <Button asChild size="sm" variant="ghost">
            <a href={installation.manageUrl} target="_blank" rel="noopener noreferrer">
              {t('admin.manageOnGithub')}
              <ExternalLinkIcon aria-hidden="true" />
            </a>
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="destructive"
          onClick={() => {
            setConfirm(true);
          }}
        >
          {t('admin.disconnect')}
        </Button>
      </div>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        {confirm ? (
          <DialogContent title={t('admin.disconnectTitle')} closeLabel={t('close')}>
            <div className="flex flex-col gap-4 text-sm">
              <p>{t('admin.disconnectBody')}</p>
              <FormError error={disconnect.error} />
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setConfirm(false);
                  }}
                >
                  {t('cancel')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={disconnect.isPending}
                  onClick={() => {
                    disconnect.mutate();
                  }}
                >
                  {t('admin.disconnectConfirm')}
                </Button>
              </div>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </li>
  );
}

export function GithubRunStatusBadge({ status }: { readonly status: GithubRunStatus }) {
  const t = useTranslations('github.runStatuses');
  const tone = {
    QUEUED: 'neutral',
    RUNNING: 'warning',
    SUCCEEDED: 'success',
    PARTIALLY_FAILED: 'warning',
    FAILED: 'danger',
    CANCELLED: 'neutral',
  } as const;
  return <Badge tone={tone[status]}>{t(status)}</Badge>;
}

const REPO_STATUS_TONE = { AVAILABLE: 'success', REMOVED: 'danger', DELETED: 'danger' } as const;

export function RepositoriesSection({ active }: { readonly active: boolean }) {
  const t = useTranslations('github');
  const [includeUnavailable, setIncludeUnavailable] = useState(false);
  const [mapping, setMapping] = useState<GithubRepository | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const repositories = useGithubRepositories(active, includeUnavailable, true);
  if (!active) {
    return null;
  }
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('admin.repositories')}</CardTitle>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={includeUnavailable}
            onChange={(event) => {
              setIncludeUnavailable(event.target.checked);
            }}
          />
          {t('admin.showUnavailable')}
        </label>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {status === null ? null : <StatusMessage>{status}</StatusMessage>}
        {repositories.isPending ? (
          <ListSkeleton rows={3} />
        ) : repositories.isError ? (
          <ErrorState error={repositories.error} />
        ) : repositories.data.length === 0 ? (
          <EmptyState message={t('admin.noRepositories')} />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="github-repositories">
            {repositories.data.map((repo) => (
              <RepositoryRow
                key={repo.id}
                repo={repo}
                onStatus={setStatus}
                onMap={() => {
                  setMapping(repo);
                }}
              />
            ))}
          </ul>
        )}
        <Dialog
          open={mapping !== null}
          onOpenChange={(open) => {
            if (!open) {
              setMapping(null);
            }
          }}
        >
          {mapping === null ? null : (
            <DialogContent title={t('admin.mapTitle', { repository: mapping.fullName })} closeLabel={t('close')}>
              <MapForm
                repo={mapping}
                onDone={(project) => {
                  setMapping(null);
                  setStatus(t('admin.mapped', { repository: mapping.fullName, project }));
                }}
              />
            </DialogContent>
          )}
        </Dialog>
      </CardContent>
    </Card>
  );
}

function RepositoryRow({
  repo,
  onStatus,
  onMap,
}: {
  readonly repo: GithubRepository;
  readonly onStatus: (message: string) => void;
  readonly onMap: () => void;
}) {
  const t = useTranslations('github');
  const { dateTime } = useDateFormat();
  const errorText = useGithubErrorCode();
  const invalidate = useGithubInvalidate();
  const sync = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/integrations/github/repositories/{id}/sync', { params: { path: { id: repo.id } } }),
      ),
    onSuccess: async () => {
      onStatus(t('admin.syncQueued', { repository: repo.fullName }));
      await invalidate();
    },
  });
  const unmap = useMutation({
    mutationFn: (mapping: GithubRepository['mappings'][number]) =>
      requestEmpty(() =>
        api.DELETE('/api/v1/integrations/github/mappings/{id}', {
          params: { path: { id: mapping.id }, query: { version: mapping.version } },
        }),
      ).then(() => mapping.project.code),
    onSuccess: async (project) => {
      onStatus(t('admin.unmapped', { repository: repo.fullName, project }));
      await invalidate();
    },
  });
  const available = repo.status === 'AVAILABLE';
  const lastRun = repo.lastRun;
  const running = lastRun !== null && ACTIVE_GITHUB_RUN_STATUSES.includes(lastRun.status);
  const lastSync = [repo.lastFullSyncAt, repo.lastReconciledAt]
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" data-testid="github-repository" data-status={repo.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        <span className="flex flex-wrap gap-2">
          {repo.private ? <Badge>{t('private')}</Badge> : null}
          {repo.archived ? <Badge>{t('archived')}</Badge> : null}
          <Badge tone={REPO_STATUS_TONE[repo.status]}>{t(`repositoryStatuses.${repo.status}`)}</Badge>
        </span>
      </div>
      <p className="text-muted-foreground">
        {t('project.openCount', { count: repo.openPullCount })} ·{' '}
        {lastSync === undefined ? t('project.neverSynced') : t('project.lastSynced', { date: dateTime(lastSync) })}
      </p>
      {lastRun === null ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <GithubRunStatusBadge status={lastRun.status} />
          <span className="text-muted-foreground">{t(`runTypes.${lastRun.type}`)}</span>
          <span className="text-xs text-muted-foreground">
            {t('runs.processed', { count: lastRun.recordsProcessed })}
          </span>
          {lastRun.errorCode === null ? null : <span className="text-destructive">{errorText(lastRun.errorCode)}</span>}
        </div>
      )}
      {repo.mappings.length === 0 ? (
        <p className="text-muted-foreground">{t('admin.notMapped')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={t('admin.mappedProjects')}>
          {repo.mappings.map((mapping) => (
            <li key={mapping.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1">
              {mapping.project.code} · {mapping.project.name}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={unmap.isPending}
                aria-label={t('admin.unmapLabel', { project: mapping.project.code, repository: repo.fullName })}
                onClick={() => {
                  unmap.mutate(mapping);
                }}
              >
                {t('admin.unmap')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FormError error={sync.error ?? unmap.error} />
      {available ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onMap}>
            {t('admin.map')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={running || sync.isPending || repo.mappings.length === 0}
            onClick={() => {
              sync.mutate();
            }}
          >
            {t('admin.syncNow')}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">{t('admin.unavailableNotice')}</p>
      )}
    </li>
  );
}

function MapForm({ repo, onDone }: { readonly repo: GithubRepository; readonly onDone: (project: string) => void }) {
  const t = useTranslations('github');
  const invalidate = useGithubInvalidate();
  const projects = useProjects({});
  const [projectId, setProjectId] = useState('');
  const mapped = new Set(repo.mappings.map((mapping) => mapping.project.id));
  const create = useMutation({
    mutationFn: () =>
      request(() => api.POST('/api/v1/integrations/github/mappings', { body: { repositoryId: repo.id, projectId } })),
    onSuccess: async (result) => {
      await invalidate();
      onDone(result.data.mappings.find((mapping) => mapping.project.id === projectId)?.project.code ?? '');
    },
  });
  const errors = fieldErrorsOf(create.error);
  const options = (projects.data?.pages.flatMap((page) => page.data) ?? []).filter(
    (project) => !mapped.has(project.id),
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <FormError error={create.error} />
      <Field label={t('admin.project')} errorCode={errors.get('projectId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={projectId}
            required
            onChange={(event) => {
              setProjectId(event.target.value);
            }}
          >
            <option value="">{t('admin.chooseProject')}</option>
            {options.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <p className="text-xs text-muted-foreground">{t('admin.syncNotice')}</p>
      <div className="flex justify-end">
        <Button type="submit" disabled={create.isPending || projectId === ''}>
          {t('admin.mapSubmit')}
        </Button>
      </div>
    </form>
  );
}

export function RunsSection({ active }: { readonly active: boolean }) {
  const t = useTranslations('github');
  const { dateTime } = useDateFormat();
  const errorText = useGithubErrorCode();
  const [status, setStatus] = useState<GithubRunStatus | ''>('');
  const [selected, setSelected] = useState<string | null>(null);
  const runs = useGithubRuns(status);
  if (!active) {
    return null;
  }
  const rows = runs.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2">
        <CardTitle>{t('admin.runs')}</CardTitle>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="github-run-status">{t('admin.filterStatus')}</Label>
          <NativeSelect
            id="github-run-status"
            value={status}
            onChange={(event) => {
              setStatus(GITHUB_RUN_STATUSES.find((value) => value === event.target.value) ?? '');
            }}
          >
            <option value="">{t('admin.allStatuses')}</option>
            {GITHUB_RUN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`runStatuses.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {runs.isPending ? (
          <ListSkeleton rows={3} />
        ) : runs.isError ? (
          <ErrorState error={runs.error} />
        ) : rows.length === 0 ? (
          <EmptyState message={t('admin.noRuns')} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="github-runs">
            {rows.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
                <span className="flex flex-wrap items-center gap-2">
                  <GithubRunStatusBadge status={run.status} />
                  <span className="font-medium" dir="ltr">
                    {run.repository.fullName}
                  </span>
                  <span className="text-muted-foreground">{t(`runTypes.${run.type}`)}</span>
                  <span className="text-xs text-muted-foreground">{dateTime(run.createdAt)}</span>
                  {run.errorCode === null ? null : <span className="text-destructive">{errorText(run.errorCode)}</span>}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(run.id);
                  }}
                >
                  {t('admin.runDetails')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {runs.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={runs.isFetchingNextPage}
            onClick={() => {
              void runs.fetchNextPage();
            }}
          >
            {t('loadMore')}
          </Button>
        ) : null}
        <Dialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSelected(null);
            }
          }}
        >
          {selected === null ? null : (
            <DialogContent title={t('admin.runDetails')} closeLabel={t('close')}>
              <RunDetail id={selected} />
            </DialogContent>
          )}
        </Dialog>
      </CardContent>
    </Card>
  );
}

function RunDetail({ id }: { readonly id: string }) {
  const t = useTranslations('github');
  const { dateTime } = useDateFormat();
  const errorText = useGithubErrorCode();
  const invalidate = useGithubInvalidate();
  const detail = useGithubRun(id);
  const cancel = useMutation({
    mutationFn: (run: GithubRun) =>
      request(() =>
        api.POST('/api/v1/integrations/github/sync-runs/{id}/cancel', { params: { path: { id: run.id } } }),
      ),
    onSuccess: invalidate,
  });
  if (detail.isPending) {
    return <ListSkeleton rows={3} />;
  }
  if (detail.isError) {
    return <ErrorState error={detail.error} />;
  }
  const { run, failures } = detail.data;
  const active = ACTIVE_GITHUB_RUN_STATUSES.includes(run.status);
  return (
    <div className="flex flex-col gap-3 text-sm">
      <dl className="grid gap-2 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('admin.repository')}</dt>
          <dd dir="ltr">{run.repository.fullName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('admin.status')}</dt>
          <dd>
            <GithubRunStatusBadge status={run.status} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('admin.started')}</dt>
          <dd>{run.startedAt === null ? '—' : dateTime(run.startedAt)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('admin.finished')}</dt>
          <dd>{run.finishedAt === null ? '—' : dateTime(run.finishedAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground">{t('admin.counts')}</dt>
          <dd>
            {t('runs.counts', {
              processed: run.recordsProcessed,
              created: run.recordsCreated,
              updated: run.recordsUpdated,
              unchanged: run.recordsUnchanged,
              failed: run.recordsFailed,
            })}
          </dd>
        </div>
        {run.errorCode === null ? null : (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{t('admin.lastError')}</dt>
            <dd className="text-destructive">{errorText(run.errorCode)}</dd>
          </div>
        )}
      </dl>
      <FormError error={cancel.error} />
      {active && !run.cancelRequested ? (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => {
              cancel.mutate(run);
            }}
          >
            {t('admin.cancelRun')}
          </Button>
        </div>
      ) : null}
      <h3 className="font-semibold">{t('admin.failures')}</h3>
      {failures.length === 0 ? (
        <p className="text-muted-foreground">{t('admin.noFailures')}</p>
      ) : (
        <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto">
          {failures.map((failure) => (
            <li key={failure.id} className="rounded-md border p-2">
              {failure.prNumber === null ? '—' : `#${String(failure.prNumber)}`} · {errorText(failure.errorCode)} ·{' '}
              {t(`failureClasses.${failure.classification}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Redacted delivery log: identifiers, event names and outcomes only (payloads are never stored). */
export function DeliveriesSection({ active }: { readonly active: boolean }) {
  const t = useTranslations('github');
  const { dateTime } = useDateFormat();
  const errorText = useGithubErrorCode();
  const [status, setStatus] = useState<GithubDeliveryStatus | ''>('');
  const deliveries = useGithubDeliveries(status, active);
  if (!active) {
    return null;
  }
  const rows = deliveries.data?.pages.flatMap((page) => page.data) ?? [];
  const tone = { RECEIVED: 'neutral', PROCESSED: 'success', IGNORED: 'neutral', FAILED: 'danger' } as const;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-end justify-between gap-2">
        <CardTitle>{t('admin.deliveries')}</CardTitle>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="github-delivery-status">{t('admin.filterStatus')}</Label>
          <NativeSelect
            id="github-delivery-status"
            value={status}
            onChange={(event) => {
              setStatus(GITHUB_DELIVERY_STATUSES.find((value) => value === event.target.value) ?? '');
            }}
          >
            <option value="">{t('admin.allStatuses')}</option>
            {GITHUB_DELIVERY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`deliveryStatuses.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {deliveries.isPending ? (
          <ListSkeleton rows={3} />
        ) : deliveries.isError ? (
          <ErrorState error={deliveries.error} />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">{t('admin.noDeliveries')}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="github-deliveries">
            {rows.map((delivery) => (
              <li key={delivery.id} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                <Badge tone={tone[delivery.status]}>{t(`deliveryStatuses.${delivery.status}`)}</Badge>
                <span className="font-medium" dir="ltr">
                  {delivery.event}
                  {delivery.action === null ? '' : `.${delivery.action}`}
                </span>
                {delivery.outcome === null ? null : (
                  <span className="text-muted-foreground">
                    {t.has(`outcomes.${delivery.outcome}` as 'outcomes.ignored')
                      ? t(`outcomes.${delivery.outcome}` as 'outcomes.ignored')
                      : delivery.outcome}
                  </span>
                )}
                {delivery.errorCode === null ? null : (
                  <span className="text-destructive">{errorText(delivery.errorCode)}</span>
                )}
                <span className="text-xs text-muted-foreground">{dateTime(delivery.receivedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        {deliveries.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={deliveries.isFetchingNextPage}
            onClick={() => {
              void deliveries.fetchNextPage();
            }}
          >
            {t('loadMore')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
