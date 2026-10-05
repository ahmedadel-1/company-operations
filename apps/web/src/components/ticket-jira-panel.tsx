'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLinkIcon, LinkIcon, PlusIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { api, request, requestEmpty } from '../lib/api';
import { useDateFormat } from '../lib/format';
import { JIRA_LINK_TYPES, jiraKeys, useJiraIssueTypes, useTicketJira, useTicketJiraSearch } from '../lib/jira';
import type { JiraIssue, JiraLinkType, JiraStatusCategory, TicketJiraLink, TicketJiraPanel } from '../lib/jira';
import { supportKeys } from '../lib/support';
import type { Ticket } from '../lib/support';
import { Field, fieldErrorsOf, FormError, StatusMessage } from './form';
import { EmptyState, ErrorState, ListSkeleton } from './states';

const LOCKED = new Set(['CLOSED', 'CANCELLED']);

export function JiraStatusBadge({
  issue,
}: {
  readonly issue: Pick<JiraIssue, 'statusName' | 'statusCategory' | 'isBlocked'>;
}) {
  const t = useTranslations('jira');
  const tone: Record<JiraStatusCategory, 'neutral' | 'warning' | 'success'> = {
    TODO: 'neutral',
    IN_PROGRESS: 'warning',
    DONE: 'success',
  };
  return (
    <span className="inline-flex flex-wrap gap-1">
      <Badge tone={tone[issue.statusCategory]}>
        {issue.statusName}
        <span className="sr-only"> ({t(`categories.${issue.statusCategory}`)})</span>
      </Badge>
      {issue.isBlocked ? <Badge tone="danger">{t('blocked')}</Badge> : null}
    </span>
  );
}

/** Opens the issue in Jira in a new tab; the accessible name says so. */
export function JiraIssueLink({ issue }: { readonly issue: Pick<JiraIssue, 'key' | 'url'> }) {
  const t = useTranslations('jira');
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex min-h-6 items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
      aria-label={t('openInJira', { key: issue.key })}
    >
      {issue.key}
      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
    </a>
  );
}

function useJiraRefresh(ticketId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: jiraKeys.ticket(ticketId) }),
      queryClient.invalidateQueries({ queryKey: supportKeys.history(ticketId) }),
    ]);
}

/** "Development (Jira)" card of a ticket (UI_UX.md §3.4). Hidden for members without `jira.view`. */
export function TicketJiraCard({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations('jira');
  const panel = useTicketJira(ticket.id);
  if (panel.isSuccess && !panel.data.visible) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('ticket.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm" data-testid="ticket-jira">
        {panel.isPending ? (
          <ListSkeleton rows={2} />
        ) : panel.isError ? (
          <ErrorState
            error={panel.error}
            onRetry={() => {
              void panel.refetch();
            }}
          />
        ) : (
          <PanelBody ticket={ticket} panel={panel.data} />
        )}
      </CardContent>
    </Card>
  );
}

function PanelBody({ ticket, panel }: { readonly ticket: Ticket; readonly panel: TicketJiraPanel }) {
  const t = useTranslations('jira');
  const [dialog, setDialog] = useState<'link' | 'create' | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const locked = LOCKED.has(ticket.status);
  return (
    <>
      {panel.connectionStatus === 'NEEDS_REAUTH' ? (
        <p className="rounded-md border border-warning/40 p-2 text-warning">{t('ticket.reauth')}</p>
      ) : !panel.available && panel.links.length === 0 ? (
        <p className="text-muted-foreground">{t('ticket.notMapped')}</p>
      ) : null}
      {panel.links.length === 0 ? (
        panel.available ? (
          <p className="text-muted-foreground">{t('ticket.empty')}</p>
        ) : null
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t('ticket.linked')}>
          {panel.links.map((link) => (
            <LinkItem
              key={link.id}
              ticket={ticket}
              link={link}
              canUnlink={panel.canLink && !locked}
              onUnlinked={() => {
                setStatus(t('ticket.unlinked', { key: link.issue.key }));
              }}
            />
          ))}
        </ul>
      )}
      {status === null ? null : <StatusMessage>{status}</StatusMessage>}
      {!locked && (panel.canLink || panel.canCreate) ? (
        <div className="flex flex-wrap gap-2">
          {panel.canLink ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDialog('link');
              }}
            >
              <LinkIcon aria-hidden="true" />
              {t('ticket.link')}
            </Button>
          ) : null}
          {panel.canCreate ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDialog('create');
              }}
            >
              <PlusIcon aria-hidden="true" />
              {t('ticket.create')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
          }
        }}
      >
        {dialog === 'link' ? (
          <DialogContent title={t('ticket.linkTitle', { ticket: ticket.key })} closeLabel={t('close')}>
            <LinkDialog
              ticket={ticket}
              onDone={(key) => {
                setDialog(null);
                setStatus(t('ticket.linkedStatus', { key }));
              }}
            />
          </DialogContent>
        ) : dialog === 'create' ? (
          <DialogContent title={t('ticket.createTitle', { ticket: ticket.key })} closeLabel={t('close')}>
            <CreateDialog
              ticket={ticket}
              panel={panel}
              onDone={(key) => {
                setDialog(null);
                setStatus(t('ticket.createdStatus', { key }));
              }}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function LinkItem({
  ticket,
  link,
  canUnlink,
  onUnlinked,
}: {
  readonly ticket: Ticket;
  readonly link: TicketJiraLink;
  readonly canUnlink: boolean;
  readonly onUnlinked: () => void;
}) {
  const t = useTranslations('jira');
  const { date } = useDateFormat();
  const refresh = useJiraRefresh(ticket.id);
  const unlink = useMutation({
    mutationFn: () =>
      requestEmpty(() =>
        api.DELETE('/api/v1/support/tickets/{id}/jira/links/{linkId}', {
          params: { path: { id: ticket.id, linkId: link.id } },
        }),
      ),
    onSuccess: async () => {
      onUnlinked();
      await refresh();
    },
  });
  const issue = link.issue;
  return (
    <li className="flex flex-col gap-1 rounded-md border p-2" data-testid="jira-link">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <JiraIssueLink issue={issue} />
        <JiraStatusBadge issue={issue} />
      </div>
      <p className="break-words">{issue.summary}</p>
      <p className="text-xs text-muted-foreground">
        {t(`linkTypes.${link.linkType}`)}
        {link.createdVia === 'CREATED_FROM_TICKET' ? ` · ${t('ticket.createdHere')}` : ''}
        {issue.assigneeDisplayName === null ? '' : ` · ${issue.assigneeDisplayName}`}
        {issue.dueDate === null ? '' : ` · ${t('due', { date: date(issue.dueDate) })}`}
      </p>
      {issue.removedInJira ? <Badge tone="warning">{t('removedInJira')}</Badge> : null}
      <p className="text-xs text-muted-foreground">{t('syncedAt', { date: date(issue.lastSyncedAt) })}</p>
      {canUnlink ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={unlink.isPending}
            onClick={() => {
              unlink.mutate();
            }}
            aria-label={t('ticket.unlinkLabel', { key: issue.key })}
          >
            <XIcon aria-hidden="true" />
            {t('ticket.unlink')}
          </Button>
        </div>
      ) : null}
      <FormError error={unlink.error} />
    </li>
  );
}

function LinkDialog({ ticket, onDone }: { readonly ticket: Ticket; readonly onDone: (key: string) => void }) {
  const t = useTranslations('jira');
  const refresh = useJiraRefresh(ticket.id);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'cache' | 'jira'>('cache');
  const [linkType, setLinkType] = useState<JiraLinkType>('FIX_TRACKED_BY');
  const results = useTicketJiraSearch(ticket.id, query, source, true);
  const link = useMutation({
    mutationFn: (issue: { id: string; key: string }) =>
      request(() =>
        api.POST('/api/v1/support/tickets/{id}/jira/links', {
          params: { path: { id: ticket.id } },
          body: { issueId: issue.id, linkType },
        }),
      ).then(() => issue.key),
    onSuccess: async (key) => {
      await refresh();
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
          <Label htmlFor="jira-search">{t('ticket.searchLabel')}</Label>
          <Input
            id="jira-search"
            value={draft}
            maxLength={100}
            placeholder={t('ticket.searchPlaceholder')}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </div>
        <Button type="submit" variant="outline">
          {t('ticket.search')}
        </Button>
      </form>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="jira-search-source">{t('ticket.source')}</Label>
          <NativeSelect
            id="jira-search-source"
            value={source}
            onChange={(event) => {
              setSource(event.target.value === 'jira' ? 'jira' : 'cache');
            }}
          >
            <option value="cache">{t('ticket.sourceCache')}</option>
            <option value="jira">{t('ticket.sourceJira')}</option>
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="jira-link-type">{t('ticket.linkType')}</Label>
          <NativeSelect
            id="jira-link-type"
            value={linkType}
            onChange={(event) => {
              const next = JIRA_LINK_TYPES.find((value) => value === event.target.value);
              if (next !== undefined) {
                setLinkType(next);
              }
            }}
          >
            {JIRA_LINK_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`linkTypes.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <FormError error={link.error} />
      {results.isPending ? (
        <ListSkeleton rows={3} />
      ) : results.isError ? (
        <ErrorState error={results.error} />
      ) : results.data.length === 0 ? (
        <EmptyState message={t('ticket.noResults')} />
      ) : (
        <ul
          className="flex max-h-80 flex-col gap-2 overflow-y-auto"
          aria-label={t('ticket.results')}
          aria-busy={results.isFetching}
        >
          {results.data.map((issue) => (
            <li
              key={issue.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  <JiraIssueLink issue={issue} />
                  <JiraStatusBadge issue={issue} />
                </span>
                <span className="break-words">{issue.summary}</span>
              </div>
              {issue.linked ? (
                <Badge>{t('ticket.alreadyLinked')}</Badge>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={link.isPending}
                  aria-label={t('ticket.linkIssue', { key: issue.key })}
                  onClick={() => {
                    link.mutate({ id: issue.id, key: issue.key });
                  }}
                >
                  {t('ticket.linkShort')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateDialog({
  ticket,
  panel,
  onDone,
}: {
  readonly ticket: Ticket;
  readonly panel: TicketJiraPanel;
  readonly onDone: (key: string) => void;
}) {
  const t = useTranslations('jira');
  const common = useTranslations('common');
  const refresh = useJiraRefresh(ticket.id);
  // One key per dialog: a double submit or a retry after a lost response never creates two issues.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [mappingId, setMappingId] = useState(panel.mappings[0]?.id ?? '');
  const [issueTypeId, setIssueTypeId] = useState('');
  const [summary, setSummary] = useState(ticket.title.slice(0, 255));
  const [description, setDescription] = useState(ticket.description.slice(0, 10_000));
  const [linkType, setLinkType] = useState<JiraLinkType>('FIX_TRACKED_BY');
  const types = useJiraIssueTypes(ticket.id, mappingId);
  const effectiveType = issueTypeId !== '' ? issueTypeId : (types.data?.[0]?.id ?? '');
  const create = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/support/tickets/{id}/jira/issues', {
          params: { path: { id: ticket.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { mappingId, issueTypeId: effectiveType, summary, description, linkType },
        }),
      ),
    onSuccess: async (result) => {
      await refresh();
      onDone(result.data.issue.key);
    },
  });
  const errors = fieldErrorsOf(create.error);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <p className="rounded-md border p-2 text-sm text-muted-foreground">{t('ticket.createNotice')}</p>
      <FormError error={create.error} />
      <Field label={t('ticket.jiraProject')} errorCode={errors.get('mappingId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={mappingId}
            onChange={(event) => {
              setMappingId(event.target.value);
              setIssueTypeId('');
            }}
          >
            {panel.mappings.map((mapping) => (
              <option key={mapping.id} value={mapping.id}>
                {mapping.jiraProjectKey} · {mapping.jiraProjectName}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('ticket.issueType')} errorCode={errors.get('issueTypeId')}>
        {(control) =>
          types.isError ? (
            <ErrorState error={types.error} />
          ) : (
            <NativeSelect
              {...control}
              value={effectiveType}
              disabled={types.isPending}
              onChange={(event) => {
                setIssueTypeId(event.target.value);
              }}
            >
              {(types.data ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </NativeSelect>
          )
        }
      </Field>
      <Field label={t('ticket.summary')} errorCode={errors.get('summary')}>
        {(control) => (
          <Input
            {...control}
            value={summary}
            required
            maxLength={255}
            onChange={(event) => {
              setSummary(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('ticket.description')} hint={t('ticket.descriptionHint')} errorCode={errors.get('description')}>
        {(control) => (
          <Textarea
            {...control}
            value={description}
            rows={6}
            maxLength={10_000}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('ticket.linkType')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={linkType}
            onChange={(event) => {
              const next = JIRA_LINK_TYPES.find((value) => value === event.target.value);
              if (next !== undefined) {
                setLinkType(next);
              }
            }}
          >
            {JIRA_LINK_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`linkTypes.${value}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={create.isPending || effectiveType === '' || summary.trim() === ''}>
          {create.isPending ? common('saving') : t('ticket.createSubmit')}
        </Button>
      </div>
    </form>
  );
}
