'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeIcon, EyeOffIcon, LockIcon, PencilIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';
import { cn } from '@company-ops/ui/lib/utils';

import { api, request } from '../lib/api';
import { useDateFormat } from '../lib/format';
import { useProjects } from '../lib/projects';
import { useTeams } from '../lib/queries';
import { useCan, useSession } from '../lib/session';
import {
  supportKeys,
  TICKET_IMPACTS,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_SOURCES,
  TICKET_STATUSES,
  useSupportCategories,
  useSupportComponents,
  useTicketAssignees,
  useTicketComments,
  useTicketHistory,
  useTicketWatchers,
} from '../lib/support';
import type { Ticket, TicketComment, TicketEvent, TicketStatus } from '../lib/support';
import { Field, fieldErrorsOf, FormError, StatusMessage } from './form';
import { DetailList } from './people';
import { Attachments, TICKET_ATTACHMENT_TYPES } from './report-attachments';
import { ErrorState, ListSkeleton, PageHeader } from './states';
import { SeverityBadge, SlaBadge, TicketStatusBadge, useTicketPerson } from './support';
import { TicketGithubCard } from './ticket-github-panel';
import { TicketJiraCard } from './ticket-jira-panel';

const LOCKED: readonly TicketStatus[] = ['CLOSED', 'CANCELLED'];
const REOPEN_FROM: readonly TicketStatus[] = ['RESOLVED', 'VERIFIED', 'CLOSED'];

/** Keeps the cached ticket in sync after a write and refreshes everything derived from it. */
function useTicketRefresh(ticketId: string) {
  const queryClient = useQueryClient();
  return async (ticket?: Ticket) => {
    if (ticket !== undefined) {
      queryClient.setQueryData(supportKeys.ticket(ticketId), ticket);
    } else {
      await queryClient.invalidateQueries({ queryKey: supportKeys.ticket(ticketId), exact: true });
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: supportKeys.history(ticketId) }),
      queryClient.invalidateQueries({ queryKey: ['support', 'tickets'] }),
      queryClient.invalidateQueries({ queryKey: ['support', 'project'] }),
    ]);
  };
}

export function TicketDetail({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations();
  const person = useTicketPerson();
  const { dateTime } = useDateFormat();
  return (
    <>
      <PageHeader
        title={ticket.title}
        description={`${ticket.key} · ${t('support.detail.reportedBy', {
          name: person(ticket.reporter),
          date: dateTime(ticket.createdAt),
        })}`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TicketStatusBadge status={ticket.status} />
        <SeverityBadge severity={ticket.severity} />
        <Badge>{t(`support.priorities.${ticket.priority}`)}</Badge>
        {ticket.escalationLevel > 0 ? (
          <Badge tone="danger">{t('support.escalation.level', { level: ticket.escalationLevel })}</Badge>
        ) : null}
        {ticket.sla?.resolutionState == null ? null : (
          <SlaBadge state={ticket.sla.resolutionState} label={t('support.slaInfo.resolution')} />
        )}
      </div>
      {ticket.status === 'WAITING_FOR_DEVELOPMENT' ? (
        <p className="mb-4 rounded-md border p-3 text-sm text-muted-foreground">
          {t('support.detail.waitingForDevelopment')}
        </p>
      ) : null}
      <TransitionBar ticket={ticket} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <DescriptionCard ticket={ticket} />
          <Conversation ticket={ticket} />
          <History ticket={ticket} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <SlaCard ticket={ticket} />
          <DetailsCard ticket={ticket} />
          <AssignmentCard ticket={ticket} />
          <WatchersCard ticket={ticket} />
          <TicketJiraCard ticket={ticket} />
          <TicketGithubCard ticket={ticket} />
          <Card>
            <CardContent>
              <TicketAttachments ticket={ticket} />
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

// ---- Lifecycle ----

function TransitionBar({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations();
  const [target, setTarget] = useState<Ticket['access']['transitions'][number] | null>(null);
  const [done, setDone] = useState(false);
  if (ticket.access.transitions.length === 0) {
    return null;
  }
  const labelOf = (to: TicketStatus) =>
    to === 'IN_PROGRESS' && REOPEN_FROM.includes(ticket.status)
      ? t('support.transitions.reopen')
      : t(`support.transitions.${to}`);
  return (
    <section aria-label={t('support.detail.actions')} className="mb-4 flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {ticket.access.transitions.map((transition) => (
          <Button
            key={transition.to}
            variant={transition.to === 'RESOLVED' || transition.to === 'VERIFIED' ? 'default' : 'outline'}
            onClick={() => {
              setDone(false);
              setTarget(transition);
            }}
          >
            {labelOf(transition.to)}
          </Button>
        ))}
      </div>
      {done ? <StatusMessage>{t('support.transitions.done')}</StatusMessage> : null}
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null);
          }
        }}
      >
        {target === null ? null : (
          <DialogContent title={`${labelOf(target.to)} · ${ticket.key}`} closeLabel={t('common.close')}>
            <TransitionForm
              ticket={ticket}
              to={target.to}
              noteRequired={target.noteRequired}
              label={labelOf(target.to)}
              onDone={() => {
                setTarget(null);
                setDone(true);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}

function TransitionForm({
  ticket,
  to,
  noteRequired,
  label,
  onDone,
}: {
  readonly ticket: Ticket;
  readonly to: TicketStatus;
  readonly noteRequired: boolean;
  readonly label: string;
  readonly onDone: () => void;
}) {
  const t = useTranslations();
  const refresh = useTicketRefresh(ticket.id);
  const [note, setNote] = useState('');
  const transition = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.POST('/api/v1/support/tickets/{id}/transitions', {
            params: { path: { id: ticket.id } },
            body: { to, version: ticket.version, ...(note.trim() === '' ? {} : { note: note.trim() }) },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone();
    },
  });
  const errors = fieldErrorsOf(transition.error);
  const hint =
    to === 'RESOLVED'
      ? t('support.transitions.resolveHint')
      : to === 'CLOSED'
        ? t('support.transitions.closeHint')
        : noteRequired
          ? t('support.transitions.noteRequired')
          : t('support.transitions.noteOptional');
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    transition.mutate();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={transition.error} />
      <Field label={t('support.transitions.note')} hint={hint} errorCode={errors.get('note')} optional={!noteRequired}>
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            maxLength={2000}
            required={noteRequired}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={transition.isPending || (noteRequired && note.trim() === '')}>
        {transition.isPending ? t('common.saving') : label}
      </Button>
    </form>
  );
}

// ---- Description ----

function DescriptionCard({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations();
  const refresh = useTicketRefresh(ticket.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: ticket.title, description: ticket.description });
  const save = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.PATCH('/api/v1/support/tickets/{id}', {
            params: { path: { id: ticket.id } },
            body: {
              version: ticket.version,
              ...(draft.title.trim() === ticket.title ? {} : { title: draft.title.trim() }),
              ...(draft.description.trim() === ticket.description ? {} : { description: draft.description.trim() }),
            },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      setEditing(false);
    },
  });
  const errors = fieldErrorsOf(save.error);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('support.detail.description')}</CardTitle>
        {ticket.access.canEdit && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft({ title: ticket.title, description: ticket.description });
              setEditing(true);
            }}
          >
            <PencilIcon aria-hidden="true" />
            {t('support.detail.edit')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {editing ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate();
            }}
          >
            <FormError error={save.error} />
            <Field label={t('support.create.summary')} errorCode={errors.get('title')}>
              {(control) => (
                <Input
                  {...control}
                  maxLength={200}
                  value={draft.title}
                  onChange={(event) => {
                    setDraft({ ...draft, title: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('support.create.description')} errorCode={errors.get('description')}>
              {(control) => (
                <Textarea
                  {...control}
                  rows={6}
                  maxLength={10000}
                  value={draft.description}
                  onChange={(event) => {
                    setDraft({ ...draft, description: event.target.value });
                  }}
                />
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={
                  save.isPending ||
                  (draft.title.trim() === ticket.title && draft.description.trim() === ticket.description)
                }
              >
                {save.isPending ? t('common.saving') : t('common.save')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setEditing(false);
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm break-words whitespace-pre-wrap">{ticket.description}</p>
        )}
        {ticket.resolutionNote === null ? null : (
          <div className="rounded-md border p-3">
            <h3 className="text-sm font-medium">{t('support.detail.resolution')}</h3>
            <p className="text-sm break-words whitespace-pre-wrap">{ticket.resolutionNote}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Conversation ----

function Conversation({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations();
  const comments = useTicketComments(ticket.id);
  const rows = comments.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('support.comments.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {comments.isPending ? (
          <ListSkeleton rows={2} />
        ) : comments.isError ? (
          <ErrorState
            error={comments.error}
            onRetry={() => {
              void comments.refetch();
            }}
          />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('support.comments.empty')}</p>
        ) : (
          <ol className="flex flex-col gap-3" data-testid="ticket-comments">
            {rows.map((comment) => (
              <CommentItem key={comment.id} ticket={ticket} comment={comment} />
            ))}
          </ol>
        )}
        {comments.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={comments.isFetchingNextPage}
            onClick={() => {
              void comments.fetchNextPage();
            }}
          >
            {t('common.loadMore')}
          </Button>
        ) : null}
        {LOCKED.includes(ticket.status) ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LockIcon aria-hidden="true" className="size-4" />
            {t('support.comments.locked')}
          </p>
        ) : ticket.access.canComment || ticket.access.canAddInternalNote ? (
          <Composer ticket={ticket} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function CommentItem({ ticket, comment }: { readonly ticket: Ticket; readonly comment: TicketComment }) {
  const t = useTranslations();
  const person = useTicketPerson();
  const { dateTime } = useDateFormat();
  const queryClient = useQueryClient();
  const refresh = useTicketRefresh(ticket.id);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const internal = comment.visibility === 'INTERNAL_NOTE';
  const save = useMutation({
    mutationFn: () =>
      request(() =>
        api.PATCH('/api/v1/support/tickets/{id}/comments/{commentId}', {
          params: { path: { id: ticket.id, commentId: comment.id } },
          body: { body: body.trim() },
        }),
      ),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: supportKeys.comments(ticket.id) });
      await refresh();
    },
  });
  return (
    <li
      className={cn('flex flex-col gap-2 rounded-lg border p-3', internal && 'border-warning/50 bg-warning/5')}
      data-testid={internal ? 'internal-note' : 'public-comment'}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{person(comment.author)}</span>
          {internal ? (
            <Badge tone="warning">
              <LockIcon aria-hidden="true" className="size-3" />
              {t('support.comments.internalBadge')}
            </Badge>
          ) : null}
          <time dateTime={comment.createdAt} className="text-muted-foreground">
            {dateTime(comment.createdAt)}
          </time>
          {comment.editedAt === null ? null : (
            <span className="text-muted-foreground">({t('support.comments.edited')})</span>
          )}
        </span>
        {comment.canEdit && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('support.comments.editLabel', { name: comment.author.name })}
            onClick={() => {
              setBody(comment.body);
              setEditing(true);
            }}
          >
            <PencilIcon aria-hidden="true" />
            {t('support.comments.edit')}
          </Button>
        ) : null}
      </div>
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <FormError error={save.error} />
          <Label htmlFor={`edit-${comment.id}`} className="sr-only">
            {t('support.comments.body')}
          </Label>
          <Textarea
            id={`edit-${comment.id}`}
            rows={3}
            maxLength={10000}
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={save.isPending || body.trim() === ''}>
              {t('support.comments.save')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditing(false);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm break-words whitespace-pre-wrap">{comment.body}</p>
      )}
    </li>
  );
}

function Composer({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations();
  const id = useId();
  const queryClient = useQueryClient();
  const refresh = useTicketRefresh(ticket.id);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'PUBLIC_INTERNAL' | 'INTERNAL_NOTE'>(
    ticket.access.canComment ? 'PUBLIC_INTERNAL' : 'INTERNAL_NOTE',
  );
  const send = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/support/tickets/{id}/comments', {
          params: { path: { id: ticket.id } },
          body: { body: body.trim(), visibility: kind },
        }),
      ),
    onSuccess: async () => {
      setBody('');
      await queryClient.invalidateQueries({ queryKey: supportKeys.comments(ticket.id) });
      await refresh();
    },
  });
  const internal = kind === 'INTERNAL_NOTE';
  return (
    <form
      className={cn('flex flex-col gap-3 rounded-lg border p-3', internal && 'border-warning/50 bg-warning/5')}
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate();
      }}
    >
      <FormError error={send.error} />
      {ticket.access.canComment && ticket.access.canAddInternalNote ? (
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 text-sm font-medium">{t('support.comments.kind')}</legend>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-kind`}
              checked={!internal}
              onChange={() => {
                setKind('PUBLIC_INTERNAL');
              }}
            />
            {t('support.comments.public')}
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-kind`}
              checked={internal}
              onChange={() => {
                setKind('INTERNAL_NOTE');
              }}
            />
            <LockIcon aria-hidden="true" className="size-3" />
            {t('support.comments.internal')}
          </label>
        </fieldset>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-body`}>{internal ? t('support.comments.internal') : t('support.comments.body')}</Label>
        <Textarea
          id={`${id}-body`}
          rows={4}
          maxLength={10000}
          aria-describedby={`${id}-hint`}
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {internal ? t('support.comments.internalHint') : t('support.comments.publicHint')}
        </p>
      </div>
      <Button type="submit" className="self-start" disabled={send.isPending || body.trim() === ''}>
        {send.isPending
          ? t('support.comments.sending')
          : internal
            ? t('support.comments.sendInternal')
            : t('support.comments.send')}
      </Button>
    </form>
  );
}

// ---- History ----

const HISTORY_TYPES = [
  'CREATED',
  'DETAILS_EDITED',
  'TRIAGED',
  'STATUS_CHANGED',
  'SEVERITY_CHANGED',
  'PRIORITY_CHANGED',
  'IMPACT_CHANGED',
  'SOURCE_CHANGED',
  'CATEGORY_CHANGED',
  'COMPONENT_CHANGED',
  'PROJECT_CHANGED',
  'TEAM_CHANGED',
  'ASSIGNED',
  'UNASSIGNED',
  'ESCALATED',
  'RESOLVED',
  'VERIFIED',
  'CLOSED',
  'REOPENED',
  'CANCELLED',
  'COMMENTED',
  'COMMENT_EDITED',
  'INTERNAL_NOTE_ADDED',
  'INTERNAL_NOTE_EDITED',
  'WATCHER_ADDED',
  'WATCHER_REMOVED',
  'ATTACHMENT_ADDED',
  'ATTACHMENT_REMOVED',
  'SLA_POLICY_CHANGED',
  'SLA_PAUSED',
  'SLA_RESUMED',
  'SLA_AT_RISK',
  'SLA_BREACHED',
  'SLA_ESCALATED',
  'JIRA_LINKED',
  'JIRA_UNLINKED',
  'JIRA_CREATED',
  'JIRA_STATUS_SYNCED',
] as const;
type HistoryType = (typeof HISTORY_TYPES)[number];

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function useHistoryText(): (event: TicketEvent) => string {
  const t = useTranslations('support');
  const enumLabel = (key: string, value: unknown): string => {
    if (typeof value !== 'string') {
      return t('none');
    }
    if (key === 'status' && (TICKET_STATUSES as readonly string[]).includes(value)) {
      return t(`statuses.${value as TicketStatus}`);
    }
    if (key === 'severity' && (TICKET_SEVERITIES as readonly string[]).includes(value)) {
      return t(`severities.${value as (typeof TICKET_SEVERITIES)[number]}`);
    }
    if (key === 'priority' && (TICKET_PRIORITIES as readonly string[]).includes(value)) {
      return t(`priorities.${value as (typeof TICKET_PRIORITIES)[number]}`);
    }
    if (key === 'impact' && (TICKET_IMPACTS as readonly string[]).includes(value)) {
      return t(`impacts.${value as (typeof TICKET_IMPACTS)[number]}`);
    }
    if (key === 'source' && (TICKET_SOURCES as readonly string[]).includes(value)) {
      return t(`sources.${value as (typeof TICKET_SOURCES)[number]}`);
    }
    return value;
  };
  const change = (event: TicketEvent, key: string) => ({
    from: enumLabel(key, field(event.from, key)),
    to: enumLabel(key, field(event.to, key)),
  });
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return (event) => {
    const type = HISTORY_TYPES.find((value) => value === event.type);
    if (type === undefined) {
      return t('history.types.generic');
    }
    const known: HistoryType = type;
    switch (known) {
      case 'STATUS_CHANGED':
        return t('history.types.STATUS_CHANGED', change(event, 'status'));
      case 'SEVERITY_CHANGED':
        return t('history.types.SEVERITY_CHANGED', change(event, 'severity'));
      case 'PRIORITY_CHANGED':
        return t('history.types.PRIORITY_CHANGED', change(event, 'priority'));
      case 'IMPACT_CHANGED':
        return t('history.types.IMPACT_CHANGED', change(event, 'impact'));
      case 'SOURCE_CHANGED':
        return t('history.types.SOURCE_CHANGED', change(event, 'source'));
      case 'SLA_ESCALATED': {
        const level = field(event.to, 'escalationLevel');
        return t('history.types.SLA_ESCALATED', { level: typeof level === 'number' ? level : 0 });
      }
      case 'JIRA_LINKED':
      case 'JIRA_CREATED':
        return t(`history.types.${known}`, { issue: text(field(event.to, 'issueKey')) });
      case 'JIRA_UNLINKED':
        return t('history.types.JIRA_UNLINKED', { issue: text(field(event.from, 'issueKey')) });
      case 'JIRA_STATUS_SYNCED':
        return t('history.types.JIRA_STATUS_SYNCED', {
          from: text(field(event.from, 'status')),
          to: text(field(event.to, 'status')),
        });
      default:
        return t(`history.types.${known}`);
    }
  };
}

function History({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations();
  const history = useTicketHistory(ticket.id);
  const text = useHistoryText();
  const person = useTicketPerson();
  const { dateTime } = useDateFormat();
  const rows = history.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('support.history.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {history.isPending ? (
          <ListSkeleton rows={3} />
        ) : history.isError ? (
          <ErrorState
            error={history.error}
            onRetry={() => {
              void history.refetch();
            }}
          />
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('support.history.empty')}</p>
        ) : (
          <ol className="flex flex-col gap-2 text-sm" data-testid="ticket-history">
            {rows.map((event) => {
              const note = field(event.metadata, 'note');
              return (
                <li key={event.id} className="flex flex-col gap-0.5 border-s-2 ps-3">
                  <span>
                    <span className="font-medium">
                      {event.actor === null ? t('support.history.system') : person(event.actor)}
                    </span>{' '}
                    · {text(event)}
                  </span>
                  {typeof note === 'string' ? (
                    <span className="break-words whitespace-pre-wrap text-muted-foreground">
                      {t('support.history.note', { note })}
                    </span>
                  ) : null}
                  <time dateTime={event.createdAt} className="text-xs text-muted-foreground">
                    {dateTime(event.createdAt)}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
        {history.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={history.isFetchingNextPage}
            onClick={() => {
              void history.fetchNextPage();
            }}
          >
            {t('common.loadMore')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---- SLA ----

function SlaCard({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations('support');
  const { dateTime } = useDateFormat();
  const sla = ticket.sla;
  return (
    <Card data-testid="ticket-sla">
      <CardHeader>
        <CardTitle>{t('slaInfo.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {sla === null ? (
          <p className="text-muted-foreground">{t('slaInfo.none')}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{t('slaInfo.policy', { name: sla.policy.name })}</p>
            <div className="flex flex-col gap-1">
              {sla.firstResponseState === null ? null : (
                <SlaBadge state={sla.firstResponseState} label={t('slaInfo.firstResponse')} />
              )}
              <span className="text-muted-foreground">
                {sla.firstRespondedAt !== null
                  ? t('slaInfo.respondedAt', { time: dateTime(sla.firstRespondedAt) })
                  : sla.firstResponseDueAt !== null
                    ? t('slaInfo.due', { time: dateTime(sla.firstResponseDueAt) })
                    : null}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {sla.resolutionState === null ? null : (
                <SlaBadge state={sla.resolutionState} label={t('slaInfo.resolution')} />
              )}
              {sla.resolutionDueAt === null ? null : (
                <span className="text-muted-foreground">
                  {t('slaInfo.due', { time: dateTime(sla.resolutionDueAt) })}
                </span>
              )}
            </div>
            {sla.paused ? <p className="text-muted-foreground">{t('slaInfo.paused')}</p> : null}
          </>
        )}
        <p>
          {ticket.escalationLevel > 0 ? t('escalation.level', { level: ticket.escalationLevel }) : t('escalation.none')}
        </p>
      </CardContent>
    </Card>
  );
}

// ---- Classification ----

function DetailsCard({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations('support');
  const person = useTicketPerson();
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? t('classify.title') : t('detail.details')}</CardTitle>
        {ticket.access.canClassify && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilIcon aria-hidden="true" />
            {t('classify.title')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {editing ? (
          <ClassifyForm
            ticket={ticket}
            onDone={() => {
              setEditing(false);
            }}
          />
        ) : (
          <DetailList
            items={[
              [t('status'), t(`statuses.${ticket.status}`)],
              [t('severity'), t(`severities.${ticket.severity}`)],
              [t('priority'), t(`priorities.${ticket.priority}`)],
              [t('impact'), t(`impacts.${ticket.impact}`)],
              [t('source'), t(`sources.${ticket.source}`)],
              [
                t('project'),
                ticket.project === null ? t('noProject') : `${ticket.project.code} · ${ticket.project.name}`,
              ],
              [t('category'), ticket.category?.name ?? null],
              [t('component'), ticket.component?.name ?? null],
              [t('reporter'), person(ticket.reporter)],
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ClassifyForm({ ticket, onDone }: { readonly ticket: Ticket; readonly onDone: () => void }) {
  const t = useTranslations();
  const can = useCan();
  const refresh = useTicketRefresh(ticket.id);
  const [form, setForm] = useState({
    severity: ticket.severity,
    priority: ticket.priority,
    impact: ticket.impact,
    source: ticket.source,
    projectId: ticket.project?.id ?? '',
    categoryId: ticket.category?.id ?? '',
    componentId: ticket.component?.id ?? '',
  });
  const projects = useProjects({}, can('project.view'));
  const categories = useSupportCategories();
  const components = useSupportComponents({ projectId: form.projectId === '' ? null : form.projectId });
  const save = useMutation({
    mutationFn: async () => {
      const nullable = (value: string) => (value === '' ? null : value);
      const body = {
        version: ticket.version,
        ...(form.severity === ticket.severity ? {} : { severity: form.severity }),
        ...(form.priority === ticket.priority ? {} : { priority: form.priority }),
        ...(form.impact === ticket.impact ? {} : { impact: form.impact }),
        ...(form.source === ticket.source ? {} : { source: form.source }),
        ...(form.projectId === (ticket.project?.id ?? '') ? {} : { projectId: nullable(form.projectId) }),
        ...(form.categoryId === (ticket.category?.id ?? '') ? {} : { categoryId: nullable(form.categoryId) }),
        ...(form.componentId === (ticket.component?.id ?? '') ? {} : { componentId: nullable(form.componentId) }),
      };
      return (
        await request(() => api.PATCH('/api/v1/support/tickets/{id}', { params: { path: { id: ticket.id } }, body }))
      ).data;
    },
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const select = <V extends string>(
    label: string,
    key: 'severity' | 'priority' | 'impact' | 'source',
    values: readonly V[],
    labelOf: (value: V) => string,
  ) => (
    <Field label={label} errorCode={errors.get(key)}>
      {(control) => (
        <NativeSelect
          {...control}
          value={form[key]}
          onChange={(event) => {
            const value = values.find((option) => option === event.target.value);
            if (value !== undefined) {
              setForm({ ...form, [key]: value });
            }
          }}
        >
          {values.map((value) => (
            <option key={value} value={value}>
              {labelOf(value)}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <FormError error={save.error} />
      {select(t('support.severity'), 'severity', TICKET_SEVERITIES, (value) => t(`support.severities.${value}`))}
      {select(t('support.priority'), 'priority', TICKET_PRIORITIES, (value) => t(`support.priorities.${value}`))}
      {select(t('support.impact'), 'impact', TICKET_IMPACTS, (value) => t(`support.impacts.${value}`))}
      {select(t('support.source'), 'source', TICKET_SOURCES, (value) => t(`support.sources.${value}`))}
      {can('project.view') ? (
        <Field label={t('support.project')} errorCode={errors.get('projectId')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.projectId}
              onChange={(event) => {
                setForm({ ...form, projectId: event.target.value, componentId: '' });
              }}
            >
              <option value="">{t('support.noProject')}</option>
              {ticket.project !== null &&
              !(projects.data?.pages ?? []).some((page) => page.data.some((p) => p.id === ticket.project?.id)) ? (
                <option value={ticket.project.id}>
                  {ticket.project.code} · {ticket.project.name}
                </option>
              ) : null}
              {(projects.data?.pages.flatMap((page) => page.data) ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.code} · {project.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      ) : null}
      <Field label={t('support.category')} errorCode={errors.get('categoryId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={form.categoryId}
            onChange={(event) => {
              setForm({ ...form, categoryId: event.target.value });
            }}
          >
            <option value="">{t('support.none')}</option>
            {(categories.data ?? []).map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field label={t('support.component')} errorCode={errors.get('componentId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={form.componentId}
            onChange={(event) => {
              setForm({ ...form, componentId: event.target.value });
            }}
          >
            <option value="">{t('support.none')}</option>
            {(components.data ?? []).map((component) => (
              <option key={component.id} value={component.id}>
                {component.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('support.classify.save')}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ---- Assignment ----

function AssignmentCard({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations('support');
  const person = useTicketPerson();
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('assign.title')}</CardTitle>
        {ticket.access.canAssign && !editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(true);
            }}
          >
            <PencilIcon aria-hidden="true" />
            {t('assign.change')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {editing ? (
          <AssignForm
            ticket={ticket}
            onDone={() => {
              setEditing(false);
            }}
          />
        ) : (
          <DetailList
            items={[
              [t('team'), ticket.assignedTeam?.name ?? t('noTeam')],
              [t('assignee'), person(ticket.assignee, t('unassigned'))],
            ]}
          />
        )}
      </CardContent>
    </Card>
  );
}

function AssignForm({ ticket, onDone }: { readonly ticket: Ticket; readonly onDone: () => void }) {
  const t = useTranslations();
  const refresh = useTicketRefresh(ticket.id);
  const teams = useTeams();
  const [teamId, setTeamId] = useState(ticket.assignedTeam?.id ?? '');
  const [assigneeId, setAssigneeId] = useState(ticket.assignee?.memberId ?? '');
  const candidates = useTicketAssignees(ticket.id, teamId === '' ? null : teamId, '', true);
  const save = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.PUT('/api/v1/support/tickets/{id}/assignment', {
            params: { path: { id: ticket.id } },
            body: {
              version: ticket.version,
              teamId: teamId === '' ? null : teamId,
              assigneeMemberId: assigneeId === '' ? null : assigneeId,
            },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      await refresh(updated);
      onDone();
    },
  });
  const errors = fieldErrorsOf(save.error);
  const options = candidates.data ?? [];
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <FormError error={save.error} />
      <Field label={t('support.assign.team')} errorCode={errors.get('teamId')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
              setAssigneeId('');
            }}
          >
            <option value="">{t('support.noTeam')}</option>
            {(teams.data ?? []).map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <Field
        label={t('support.assign.assignee')}
        errorCode={errors.get('assigneeMemberId')}
        hint={candidates.isSuccess && options.length === 0 ? t('support.assign.noCandidates') : undefined}
      >
        {(control) => (
          <NativeSelect
            {...control}
            value={assigneeId}
            disabled={candidates.isPending}
            onChange={(event) => {
              setAssigneeId(event.target.value);
            }}
          >
            <option value="">{t('support.unassigned')}</option>
            {options.map((candidate) => (
              <option key={candidate.memberId} value={candidate.memberId}>
                {candidate.name}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? t('common.saving') : t('support.assign.save')}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

// ---- Watchers ----

function WatchersCard({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations();
  const me = useSession();
  const person = useTicketPerson();
  const queryClient = useQueryClient();
  const refresh = useTicketRefresh(ticket.id);
  const watchers = useTicketWatchers(ticket.id);
  const candidates = useTicketAssignees(ticket.id, null, '', ticket.access.canManageWatchers);
  const [choice, setChoice] = useState('');
  const myId = me.activeOrganization.memberId;
  const after = async () => {
    await queryClient.invalidateQueries({ queryKey: supportKeys.watchers(ticket.id) });
    await refresh();
  };
  const add = useMutation({
    mutationFn: (memberId: string) =>
      request(() =>
        api.POST('/api/v1/support/tickets/{id}/watchers', {
          params: { path: { id: ticket.id } },
          body: { memberId },
        }),
      ),
    onSuccess: async () => {
      setChoice('');
      await after();
    },
  });
  const remove = useMutation({
    mutationFn: (memberId: string) =>
      request(() =>
        api.DELETE('/api/v1/support/tickets/{id}/watchers/{memberId}', {
          params: { path: { id: ticket.id, memberId } },
        }),
      ),
    onSuccess: after,
  });
  const rows = watchers.data ?? [];
  const watching = rows.some((row) => row.member.memberId === myId);
  const addable = (candidates.data ?? []).filter(
    (candidate) => !rows.some((row) => row.member.memberId === candidate.memberId),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('support.watchers.title')}</CardTitle>
        {ticket.access.canWatch ? (
          <Button
            variant="outline"
            size="sm"
            disabled={add.isPending || remove.isPending || watchers.isPending}
            onClick={() => {
              if (watching) {
                remove.mutate(myId);
              } else {
                add.mutate(myId);
              }
            }}
          >
            {watching ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
            {watching ? t('support.watchers.unwatch') : t('support.watchers.watch')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-muted-foreground">{t('support.watchers.hint')}</p>
        <FormError error={add.error ?? remove.error} />
        {watchers.isPending ? (
          <ListSkeleton rows={1} />
        ) : watchers.isError ? (
          <ErrorState error={watchers.error} />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground">{t('support.watchers.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1" data-testid="ticket-watchers">
            {rows.map((row) => (
              <li key={row.member.memberId} className="flex min-h-11 items-center justify-between gap-2">
                <span>{person(row.member)}</span>
                {ticket.access.canManageWatchers && row.member.memberId !== myId ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('support.watchers.remove', { name: row.member.name })}
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(row.member.memberId);
                    }}
                  >
                    <XIcon aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {ticket.access.canManageWatchers && addable.length > 0 ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (choice !== '') {
                add.mutate(choice);
              }
            }}
          >
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor={`watcher-${ticket.id}`}>{t('support.watchers.add')}</Label>
              <NativeSelect
                id={`watcher-${ticket.id}`}
                value={choice}
                onChange={(event) => {
                  setChoice(event.target.value);
                }}
              >
                <option value="">{t('support.watchers.choose')}</option>
                {addable.map((candidate) => (
                  <option key={candidate.memberId} value={candidate.memberId}>
                    {candidate.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" variant="outline" disabled={choice === '' || add.isPending}>
              {t('support.config.add')}
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---- Attachments ----

function TicketAttachments({ ticket }: { readonly ticket: Ticket }) {
  const t = useTranslations('support.attachments');
  return (
    <Attachments
      ownerType="SUPPORT_TICKET"
      ownerId={ticket.id}
      allowedTypes={TICKET_ATTACHMENT_TYPES}
      hint={t('hint')}
      badType={t('badType')}
      testId="ticket-attachments"
      canUpload={ticket.access.canAttach}
      canDelete={ticket.access.canClassify && !LOCKED.includes(ticket.status)}
    />
  );
}
