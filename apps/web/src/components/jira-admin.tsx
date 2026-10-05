'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlugIcon, RefreshCwIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, NativeSelect } from '@company-ops/ui/components/input';

import { api, request, requestEmpty } from '../lib/api';
import { useDateFormat } from '../lib/format';
import {
  ACTIVE_RUN_STATUSES,
  jiraKeys,
  useJiraDeliveryFailures,
  useJiraMappings,
  useJiraProjects,
  useJiraSites,
} from '../lib/jira';
import type { JiraConnection, JiraIntegrationStatus, JiraMapping, JiraRun, JiraRunType } from '../lib/jira';
import { useProjects } from '../lib/projects';
import { Field, fieldErrorsOf, FormError, StatusMessage } from './form';
import { EmptyState, ErrorState, ListSkeleton } from './states';

function useJiraInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: jiraKeys.all });
}

export function useJiraErrorCode(): (code: string | null) => string | null {
  const t = useTranslations('jira.errorCodes');
  return (code) => {
    if (code === null) {
      return null;
    }
    return t.has(code as 'generic') ? t(code as 'generic') : t('generic');
  };
}

/** Outcome of the OAuth round trip, from the callback redirect's query string. */
export function CallbackNotice({
  outcome,
  reason,
}: {
  readonly outcome: string | null;
  readonly reason: string | null;
}) {
  const t = useTranslations('jira.admin');
  if (outcome === 'connected') {
    return <StatusMessage>{t('connectedNotice')}</StatusMessage>;
  }
  if (outcome === 'error') {
    const key =
      reason === 'consent_denied'
        ? 'consentDenied'
        : reason === 'jira_reauth_required'
          ? 'differentSite'
          : 'connectFailed';
    return (
      <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
        {t(key)}
      </p>
    );
  }
  return null;
}

export function ConnectionCard({ status }: { readonly status: JiraIntegrationStatus }) {
  const t = useTranslations('jira');
  const { dateTime } = useDateFormat();
  const invalidate = useJiraInvalidate();
  const [confirm, setConfirm] = useState(false);
  const connect = useMutation({
    mutationFn: (connectionId: string | null) =>
      request(() =>
        api.POST('/api/v1/integrations/jira/connect', { body: connectionId === null ? {} : { connectionId } }),
      ),
    onSuccess: (result) => {
      window.location.assign(result.data.authorizeUrl);
    },
  });
  const disconnect = useMutation({
    mutationFn: (connection: JiraConnection) =>
      request(() =>
        api.DELETE('/api/v1/integrations/jira/connections/{id}', {
          params: { path: { id: connection.id }, query: { version: connection.version } },
        }),
      ),
    onSuccess: async () => {
      setConfirm(false);
      await invalidate();
    },
  });

  if (!status.configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.connection')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t('admin.notConfigured')}</CardContent>
      </Card>
    );
  }
  const connection = status.connection;
  const tone = { ACTIVE: 'success', NEEDS_REAUTH: 'warning', ERROR: 'danger', DISCONNECTED: 'neutral' } as const;
  const webhookTone = {
    ACTIVE: 'success',
    NOT_REGISTERED: 'neutral',
    ERROR: 'danger',
    UNSUPPORTED: 'neutral',
  } as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.connection')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <FormError error={connect.error ?? disconnect.error} />
        {connection === null ? (
          <>
            <p className="text-muted-foreground">{t('admin.notConnected')}</p>
            <div>
              <Button
                type="button"
                disabled={connect.isPending}
                onClick={() => {
                  connect.mutate(null);
                }}
              >
                <PlugIcon aria-hidden="true" />
                {t('admin.connect')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <dl className="grid gap-2 sm:grid-cols-2" data-testid="jira-connection">
              <div>
                <dt className="text-muted-foreground">{t('admin.site')}</dt>
                <dd className="font-medium break-words">
                  {connection.siteName} ({connection.siteUrl})
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('admin.status')}</dt>
                <dd>
                  <Badge tone={tone[connection.status]}>{t(`connectionStatuses.${connection.status}`)}</Badge>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('admin.connectedAt')}</dt>
                <dd>
                  {dateTime(connection.connectedAt)}
                  {connection.connectedBy?.fullName == null ? '' : ` · ${connection.connectedBy.fullName}`}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('admin.lastSuccess')}</dt>
                <dd>{connection.lastSuccessAt === null ? t('admin.never') : dateTime(connection.lastSuccessAt)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('admin.webhooks')}</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  <Badge tone={webhookTone[connection.webhook.state]}>
                    {t(`webhookStates.${connection.webhook.state}`)}
                  </Badge>
                  {connection.webhook.expiresAt === null ? null : (
                    <span className="text-muted-foreground">
                      {t('admin.expires', { date: dateTime(connection.webhook.expiresAt) })}
                    </span>
                  )}
                </dd>
              </div>
              {connection.lastErrorCode === null ? null : (
                <div>
                  <dt className="text-muted-foreground">{t('admin.lastError')}</dt>
                  <dd>{connection.lastErrorCode}</dd>
                </div>
              )}
            </dl>
            {connection.status === 'NEEDS_REAUTH' ? (
              <p role="alert" className="rounded-md border border-warning/40 p-2 text-warning">
                {t('admin.reauthNeeded')}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={connection.status === 'NEEDS_REAUTH' ? 'default' : 'outline'}
                disabled={connect.isPending}
                onClick={() => {
                  connect.mutate(connection.id);
                }}
              >
                <RefreshCwIcon aria-hidden="true" />
                {t('admin.reauthorize')}
              </Button>
              <Button
                type="button"
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
                          disconnect.mutate(connection);
                        }}
                      >
                        {t('admin.disconnectConfirm')}
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              ) : null}
            </Dialog>
          </>
        )}
        {status.redirectUri === null ? null : (
          <p className="text-xs text-muted-foreground break-all">
            {t('admin.redirectUri', { uri: status.redirectUri })}
          </p>
        )}
        {!status.webhooksSupported ? (
          <p className="text-xs text-muted-foreground">{t('admin.webhooksUnsupported')}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Several Jira sites granted at consent: the administrator picks one. */
export function SiteSelection({ grantId, onDone }: { readonly grantId: string; readonly onDone: () => void }) {
  const t = useTranslations('jira.admin');
  const invalidate = useJiraInvalidate();
  const sites = useJiraSites(grantId);
  const select = useMutation({
    mutationFn: (cloudId: string) =>
      request(() =>
        api.POST('/api/v1/integrations/jira/grants/{grantId}/select', {
          params: { path: { grantId } },
          body: { cloudId },
        }),
      ),
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('chooseSite')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <FormError error={select.error} />
        {sites.isPending ? (
          <ListSkeleton rows={2} />
        ) : sites.isError ? (
          <ErrorState error={sites.error} />
        ) : (
          <ul className="flex flex-col gap-2">
            {sites.data.map((site) => (
              <li
                key={site.cloudId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
              >
                <span>
                  <span className="font-medium">{site.name}</span>{' '}
                  <span className="text-muted-foreground">{site.url}</span>
                  {site.missingScopes.length === 0 ? null : (
                    <span className="block text-warning">
                      {t('missingScopes', { scopes: site.missingScopes.join(', ') })}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="sm"
                  disabled={select.isPending || site.missingScopes.length > 0}
                  onClick={() => {
                    select.mutate(site.cloudId);
                  }}
                >
                  {t('useSite')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function RunProgress({ run }: { readonly run: JiraRun }) {
  const t = useTranslations('jira');
  const active = ACTIVE_RUN_STATUSES.includes(run.status);
  return (
    <div className="flex min-w-40 flex-col gap-1">
      {run.progressPercent === null ? (
        <span className="text-xs text-muted-foreground">{t('runs.processed', { count: run.recordsProcessed })}</span>
      ) : (
        <>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={run.progressPercent}
            aria-label={t('runs.progressLabel', { project: run.jiraProjectKey })}
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${String(run.progressPercent)}%` }} />
          </div>
          <span className="text-xs text-muted-foreground">
            {t('runs.progress', {
              processed: run.recordsProcessed,
              total: run.recordsEstimated ?? run.recordsProcessed,
            })}
            {active ? '' : ` · ${t('runs.failedCount', { count: run.recordsFailed })}`}
          </span>
        </>
      )}
    </div>
  );
}

export function RunStatusBadge({ status }: { readonly status: JiraRun['status'] }) {
  const t = useTranslations('jira.runStatuses');
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

export function MappingsSection({ connected }: { readonly connected: boolean }) {
  const t = useTranslations('jira');
  const mappingsQuery = useJiraMappings(connected, true);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  if (!connected) {
    return null;
  }
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{t('admin.mappings')}</CardTitle>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/integrations/jira/sync">{t('admin.syncHistory')}</Link>
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('admin.addMapping')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {status === null ? null : <StatusMessage>{status}</StatusMessage>}
        {mappingsQuery.isPending ? (
          <ListSkeleton rows={3} />
        ) : mappingsQuery.isError ? (
          <ErrorState error={mappingsQuery.error} />
        ) : mappingsQuery.data.length === 0 ? (
          <EmptyState message={t('admin.noMappings')} />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="jira-mappings">
            {mappingsQuery.data.map((mapping) => (
              <MappingRow key={mapping.id} mapping={mapping} onStatus={setStatus} />
            ))}
          </ul>
        )}
        <Dialog open={adding} onOpenChange={setAdding}>
          {adding ? (
            <DialogContent title={t('admin.addMapping')} closeLabel={t('close')}>
              <AddMappingForm
                onDone={(name) => {
                  setAdding(false);
                  setStatus(t('admin.mappingAdded', { name }));
                }}
              />
            </DialogContent>
          ) : null}
        </Dialog>
      </CardContent>
    </Card>
  );
}

function MappingRow({
  mapping,
  onStatus,
}: {
  readonly mapping: JiraMapping;
  readonly onStatus: (message: string) => void;
}) {
  const t = useTranslations('jira');
  const { dateTime } = useDateFormat();
  const errorText = useJiraErrorCode();
  const invalidate = useJiraInvalidate();
  const [editing, setEditing] = useState(false);
  const [blocked, setBlocked] = useState(mapping.blockedStatuses.join(', '));
  const run = useMutation({
    mutationFn: (type: Exclude<JiraRunType, 'INITIAL_IMPORT'>) =>
      request(() =>
        api.POST('/api/v1/integrations/jira/mappings/{id}/runs', {
          params: { path: { id: mapping.id } },
          body: { type },
        }),
      ),
    onSuccess: async () => {
      onStatus(t('admin.runQueued', { key: mapping.jiraProject.key }));
      await invalidate();
    },
  });
  const update = useMutation({
    mutationFn: (body: { syncEnabled?: boolean; blockedStatuses?: string[] }) =>
      request(() =>
        api.PATCH('/api/v1/integrations/jira/mappings/{id}', {
          params: { path: { id: mapping.id } },
          body: { version: mapping.version, ...body },
        }),
      ),
    onSuccess: async () => {
      setEditing(false);
      onStatus(t('admin.mappingSaved', { key: mapping.jiraProject.key }));
      await invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      requestEmpty(() =>
        api.DELETE('/api/v1/integrations/jira/mappings/{id}', {
          params: { path: { id: mapping.id }, query: { version: mapping.version } },
        }),
      ),
    onSuccess: async () => {
      onStatus(t('admin.mappingRemoved', { key: mapping.jiraProject.key }));
      await invalidate();
    },
  });
  const lastRun = mapping.lastRun;
  const running = lastRun !== null && ACTIVE_RUN_STATUSES.includes(lastRun.status);
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" data-testid="jira-mapping">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {mapping.jiraProject.key} · {mapping.jiraProject.name} → {mapping.project.code} · {mapping.project.name}
        </span>
        <span className="flex flex-wrap gap-2">
          {mapping.syncEnabled ? null : <Badge tone="warning">{t('admin.paused')}</Badge>}
          <Badge
            tone={
              mapping.importState === 'FAILED' ? 'danger' : mapping.importState === 'COMPLETED' ? 'success' : 'neutral'
            }
          >
            {t(`importStates.${mapping.importState}`)}
          </Badge>
        </span>
      </div>
      <p className="text-muted-foreground">
        {t('admin.issueCount', { count: mapping.issueCount })} ·{' '}
        {mapping.lastReconciledAt === null
          ? t('project.neverSynced')
          : t('project.lastSynced', { date: dateTime(mapping.lastReconciledAt) })}
      </p>
      {lastRun === null ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <RunStatusBadge status={lastRun.status} />
          <span className="text-muted-foreground">{t(`runTypes.${lastRun.type}`)}</span>
          <RunProgress run={lastRun} />
          {lastRun.errorCode === null ? null : <span className="text-destructive">{errorText(lastRun.errorCode)}</span>}
        </div>
      )}
      <FormError error={run.error ?? update.error ?? remove.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={running || run.isPending || !mapping.syncEnabled}
          onClick={() => {
            run.mutate('RECONCILIATION');
          }}
        >
          {t('admin.syncNow')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={running || run.isPending || !mapping.syncEnabled}
          onClick={() => {
            run.mutate('DEEP_RECONCILIATION');
          }}
        >
          {t('admin.deepCheck')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={running || run.isPending || !mapping.syncEnabled}
          onClick={() => {
            run.mutate('MANUAL_RESYNC');
          }}
        >
          {t('admin.fullResync')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={update.isPending}
          onClick={() => {
            update.mutate({ syncEnabled: !mapping.syncEnabled });
          }}
        >
          {mapping.syncEnabled ? t('admin.pause') : t('admin.resume')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setEditing((value) => !value);
          }}
          aria-expanded={editing}
        >
          {t('admin.blockedStatuses')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate();
          }}
          aria-label={t('admin.removeMappingLabel', { key: mapping.jiraProject.key })}
        >
          {t('admin.removeMapping')}
        </Button>
      </div>
      {editing ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
            event.preventDefault();
            update.mutate({ blockedStatuses: splitStatuses(blocked) });
          }}
        >
          <div className="min-w-48 flex-1">
            <Field label={t('admin.blockedStatuses')} hint={t('admin.blockedHint')}>
              {(control) => (
                <Input
                  {...control}
                  value={blocked}
                  onChange={(event) => {
                    setBlocked(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={update.isPending}>
            {t('save')}
          </Button>
        </form>
      ) : null}
    </li>
  );
}

function splitStatuses(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .slice(0, 20);
}

/** Each project search is a live Jira call, so typing settles before it is sent. */
function useSettled(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);
  return settled;
}

function AddMappingForm({ onDone }: { readonly onDone: (name: string) => void }) {
  const t = useTranslations('jira');
  const invalidate = useJiraInvalidate();
  const projects = useProjects({});
  const [query, setQuery] = useState('');
  const jiraProjects = useJiraProjects(useSettled(query.trim(), 300), true);
  const [projectId, setProjectId] = useState('');
  const [jiraProjectId, setJiraProjectId] = useState('');
  const [blocked, setBlocked] = useState('');
  const create = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/integrations/jira/mappings', {
          body: { projectId, jiraProjectId, blockedStatuses: splitStatuses(blocked) },
        }),
      ),
    onSuccess: async (result) => {
      await invalidate();
      onDone(`${result.data.jiraProject.key} → ${result.data.project.code}`);
    },
  });
  const errors = fieldErrorsOf(create.error);
  const projectOptions = projects.data?.pages.flatMap((page) => page.data) ?? [];
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
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('admin.searchJiraProjects')}>
        {(control) => (
          <Input
            {...control}
            type="search"
            value={query}
            maxLength={100}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('admin.jiraProject')} errorCode={errors.get('jiraProjectId')}>
        {(control) =>
          jiraProjects.isError ? (
            <ErrorState error={jiraProjects.error} />
          ) : (
            <NativeSelect
              {...control}
              value={jiraProjectId}
              required
              onChange={(event) => {
                setJiraProjectId(event.target.value);
              }}
            >
              <option value="">{jiraProjects.isPending ? t('loading') : t('admin.chooseJiraProject')}</option>
              {(jiraProjects.data?.data ?? []).map((option) => (
                <option key={option.id} value={option.id} disabled={option.mappedToProjectId !== null}>
                  {option.key} · {option.name}
                  {option.mappedToProjectId === null ? '' : ` (${t('admin.alreadyMapped')})`}
                </option>
              ))}
            </NativeSelect>
          )
        }
      </Field>
      <Field label={t('admin.blockedStatuses')} hint={t('admin.blockedHint')} optional>
        {(control) => (
          <Input
            {...control}
            value={blocked}
            onChange={(event) => {
              setBlocked(event.target.value);
            }}
          />
        )}
      </Field>
      <p className="text-xs text-muted-foreground">{t('admin.importNotice')}</p>
      <div className="flex justify-end">
        <Button type="submit" disabled={create.isPending || projectId === '' || jiraProjectId === ''}>
          {t('admin.addMappingSubmit')}
        </Button>
      </div>
    </form>
  );
}

/** Webhook deliveries that failed processing (identifiers and codes only; payloads are never shown). */
export function DeliveryFailures({ connected }: { readonly connected: boolean }) {
  const t = useTranslations('jira');
  const { dateTime } = useDateFormat();
  const failures = useJiraDeliveryFailures(connected);
  if (!connected) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.deliveryFailures')}</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {failures.isPending ? (
          <ListSkeleton rows={2} />
        ) : failures.isError ? (
          <ErrorState error={failures.error} />
        ) : failures.data.length === 0 ? (
          <p className="text-muted-foreground">{t('admin.noDeliveryFailures')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {failures.data.map((failure) => (
              <li key={failure.id} className="rounded-md border p-2">
                {failure.eventType} · {failure.jiraIssueId ?? '—'} · {failure.errorCode ?? t('errorCodes.generic')} ·{' '}
                {dateTime(failure.receivedAt)}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
