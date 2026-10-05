'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LinkIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label } from '@company-ops/ui/components/input';

import { api, request, requestEmpty } from '../lib/api';
import { githubKeys, useTicketGithub, useTicketPullSearch } from '../lib/github';
import type { TicketGithubPanel, TicketPull } from '../lib/github';
import { supportKeys } from '../lib/support';
import type { Ticket } from '../lib/support';
import { FormError, StatusMessage } from './form';
import { PullItem } from './github-shared';
import { EmptyState, ErrorState, ListSkeleton } from './states';

const LOCKED = new Set(['CLOSED', 'CANCELLED']);

function useGithubRefresh(ticketId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: githubKeys.ticket(ticketId) }),
      queryClient.invalidateQueries({ queryKey: supportKeys.history(ticketId) }),
    ]);
}

/**
 * "Pull requests" card of a ticket: pull requests reached through the ticket's confirmed Jira links
 * and direct links, only from repositories mapped to the ticket's project. Hidden without
 * `github.view` on the ticket's project.
 */
export function TicketGithubCard({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations('github');
  const panel = useTicketGithub(ticket.id);
  if (panel.isSuccess && !panel.data.visible) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('ticket.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm" data-testid="ticket-github">
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

function PanelBody({ ticket, panel }: { readonly ticket: Ticket; readonly panel: TicketGithubPanel }) {
  const t = useTranslations('github');
  const [linking, setLinking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const locked = LOCKED.has(ticket.status);
  return (
    <>
      {!panel.available && panel.pulls.length === 0 ? (
        <p className="text-muted-foreground">{t('ticket.notMapped')}</p>
      ) : panel.pulls.length === 0 ? (
        <p className="text-muted-foreground">{t('ticket.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('ticket.linked')}>
          {panel.pulls.map((pull) => (
            <TicketPullRow
              key={pull.id}
              ticket={ticket}
              pull={pull}
              canUnlink={panel.canLink && !locked}
              onUnlinked={() => {
                setStatus(t('ticket.unlinked', { number: pull.number }));
              }}
            />
          ))}
        </ul>
      )}
      {status === null ? null : <StatusMessage>{status}</StatusMessage>}
      {!locked && panel.canLink ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setLinking(true);
            }}
          >
            <LinkIcon aria-hidden="true" />
            {t('ticket.link')}
          </Button>
        </div>
      ) : null}
      <Dialog open={linking} onOpenChange={setLinking}>
        {linking ? (
          <DialogContent title={t('ticket.linkTitle', { ticket: ticket.key })} closeLabel={t('close')}>
            <LinkPullDialog
              ticket={ticket}
              onDone={(number) => {
                setLinking(false);
                setStatus(t('ticket.linkedStatus', { number }));
              }}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

function TicketPullRow({
  ticket,
  pull,
  canUnlink,
  onUnlinked,
}: {
  readonly ticket: Ticket;
  readonly pull: TicketPull;
  readonly canUnlink: boolean;
  readonly onUnlinked: () => void;
}) {
  const t = useTranslations('github');
  const refresh = useGithubRefresh(ticket.id);
  const linkId = pull.ticketLinkId;
  const unlink = useMutation({
    mutationFn: (id: string) =>
      requestEmpty(() =>
        api.DELETE('/api/v1/support/tickets/{id}/github/links/{linkId}', {
          params: { path: { id: ticket.id, linkId: id } },
        }),
      ),
    onSuccess: async () => {
      onUnlinked();
      await refresh();
    },
  });
  return (
    <PullItem
      pull={pull}
      projectId={null}
      canDecide={false}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {pull.via.map((via) => (
            <Badge key={via}>{t(`ticket.via.${via}`)}</Badge>
          ))}
          {canUnlink && linkId !== null ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={unlink.isPending}
              aria-label={t('ticket.unlinkLabel', { number: pull.number })}
              onClick={() => {
                unlink.mutate(linkId);
              }}
            >
              <XIcon aria-hidden="true" />
              {t('ticket.unlink')}
            </Button>
          ) : null}
          <FormError error={unlink.error} />
        </div>
      }
    />
  );
}

function LinkPullDialog({ ticket, onDone }: { readonly ticket: Ticket; readonly onDone: (number: number) => void }) {
  const t = useTranslations('github');
  const refresh = useGithubRefresh(ticket.id);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const results = useTicketPullSearch(ticket.id, query, true);
  const link = useMutation({
    mutationFn: (pull: { id: string; number: number }) =>
      request(() =>
        api.POST('/api/v1/support/tickets/{id}/github/links', {
          params: { path: { id: ticket.id } },
          body: { pullRequestId: pull.id },
        }),
      ).then(() => pull.number),
    onSuccess: async (number) => {
      await refresh();
      onDone(number);
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
          <Label htmlFor="github-pull-search">{t('ticket.searchLabel')}</Label>
          <Input
            id="github-pull-search"
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
        <EmptyState message={t('ticket.noResults')} />
      ) : (
        <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto" aria-label={t('ticket.results')}>
          {results.data.map((pull) => (
            <li
              key={pull.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm"
            >
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium" dir="ltr">
                  {pull.repository}#{pull.number}
                </span>
                <span className="break-words">{pull.title}</span>
                <span className="text-xs text-muted-foreground">{t(`pullStates.${pull.state}`)}</span>
              </span>
              {pull.linked ? (
                <Badge>{t('ticket.alreadyLinked')}</Badge>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={link.isPending}
                  aria-label={t('ticket.linkPull', { number: pull.number })}
                  onClick={() => {
                    link.mutate({ id: pull.id, number: pull.number });
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
