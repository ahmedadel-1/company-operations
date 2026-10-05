'use client';

import { AlertTriangleIcon, ClockIcon, PauseIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge } from '@company-ops/ui/components/badge';
import { Card } from '@company-ops/ui/components/card';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { useDateFormat } from '../lib/format';
import type { SlaState, TicketSeverity, TicketStatus, TicketSummary } from '../lib/support';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

const STATUS_TONES: Readonly<Record<TicketStatus, Tone>> = {
  NEW: 'warning',
  TRIAGED: 'neutral',
  IN_PROGRESS: 'neutral',
  ESCALATED: 'danger',
  WAITING_FOR_DEVELOPMENT: 'neutral',
  WAITING_FOR_CUSTOMER: 'neutral',
  RESOLVED: 'success',
  VERIFIED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'neutral',
};

export function TicketStatusBadge({ status }: { readonly status: TicketStatus }) {
  const t = useTranslations('support.statuses');
  return (
    <Badge tone={STATUS_TONES[status]} data-testid="ticket-status">
      {t(status)}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { readonly severity: TicketSeverity }) {
  const t = useTranslations('support');
  const tone = severity === 'CRITICAL' ? 'danger' : severity === 'HIGH' ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      <span className="sr-only">{t('severity')}: </span>
      {t(`severities.${severity}`)}
    </Badge>
  );
}

const SLA_TONES: Readonly<Record<NonNullable<SlaState>, Tone>> = {
  ON_TRACK: 'success',
  AT_RISK: 'warning',
  BREACHED: 'danger',
  PAUSED: 'neutral',
  MET: 'success',
};

/** The most urgent of the two SLA clocks, for compact list display. */
function worstState(sla: TicketSummary['sla']): NonNullable<SlaState> | null {
  if (sla === null) {
    return null;
  }
  const order: readonly NonNullable<SlaState>[] = ['BREACHED', 'AT_RISK', 'PAUSED', 'ON_TRACK', 'MET'];
  const states = [sla.firstResponseState, sla.resolutionState].filter(
    (state): state is NonNullable<SlaState> => state !== null,
  );
  return order.find((state) => states.includes(state)) ?? null;
}

/** SLA state as text plus icon (never color alone, UI_UX.md §7). */
export function SlaBadge({ state, label }: { readonly state: NonNullable<SlaState>; readonly label?: string }) {
  const t = useTranslations('support');
  const Icon =
    state === 'BREACHED' || state === 'AT_RISK' ? AlertTriangleIcon : state === 'PAUSED' ? PauseIcon : ClockIcon;
  return (
    <Badge tone={SLA_TONES[state]} data-testid="sla-indicator" data-state={state}>
      <Icon aria-hidden="true" className="size-3" />
      {label === undefined
        ? `${t('sla')}: ${t(`slaStates.${state}`)}`
        : t('slaInfo.indicator', { clock: label, state: t(`slaStates.${state}`) })}
    </Badge>
  );
}

export function TicketSlaSummary({ sla }: { readonly sla: TicketSummary['sla'] }) {
  const t = useTranslations('support');
  const state = worstState(sla);
  return state === null ? (
    <span className="text-sm text-muted-foreground">{t('none')}</span>
  ) : (
    <SlaBadge state={state} />
  );
}

interface PersonRef {
  readonly name: string;
  readonly active: boolean;
}

export function useTicketPerson(): (person: PersonRef | null, fallback?: string) => string {
  const t = useTranslations('support');
  return (person, fallback) => {
    if (person === null) {
      return fallback ?? t('none');
    }
    return person.active ? person.name : t('inactivePerson', { name: person.name });
  };
}

/** Queue rendering: a table from 768 px, cards below (no squeezed tables on phones, UI_UX.md §2). */
export function TicketList({ tickets, label }: { readonly tickets: readonly TicketSummary[]; readonly label: string }) {
  const t = useTranslations('support');
  const person = useTicketPerson();
  const { dateTime } = useDateFormat();
  return (
    <>
      <Card className="hidden md:block">
        <Table aria-label={label}>
          <thead>
            <TableRow>
              <TableHead>{t('ticket')}</TableHead>
              <TableHead>{t('status')}</TableHead>
              <TableHead>{t('severity')}</TableHead>
              <TableHead>{t('sla')}</TableHead>
              <TableHead>{t('assignee')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('project')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('updated')}</TableHead>
            </TableRow>
          </thead>
          <tbody>
            {tickets.map((ticket) => (
              <TableRow key={ticket.id} data-testid="ticket-row">
                <TableCell className="max-w-80">
                  <Link
                    href={`/support/tickets/${ticket.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    <span className="me-2 text-muted-foreground">{ticket.key}</span>
                    {ticket.title}
                  </Link>
                  <span className="block text-xs text-muted-foreground">{t(`priorities.${ticket.priority}`)}</span>
                </TableCell>
                <TableCell>
                  <TicketStatusBadge status={ticket.status} />
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={ticket.severity} />
                </TableCell>
                <TableCell>
                  <TicketSlaSummary sla={ticket.sla} />
                </TableCell>
                <TableCell>{person(ticket.assignee, t('unassigned'))}</TableCell>
                <TableCell className="hidden lg:table-cell">{ticket.project?.code ?? t('noProject')}</TableCell>
                <TableCell className="hidden text-sm lg:table-cell">
                  <time dateTime={ticket.updatedAt}>{dateTime(ticket.updatedAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-3 md:hidden" aria-label={label}>
        {tickets.map((ticket) => (
          <li key={ticket.id} data-testid="ticket-card">
            <Link
              href={`/support/tickets/${ticket.id}`}
              className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-accent"
            >
              <span className="text-sm text-muted-foreground">{ticket.key}</span>
              <span className="font-medium break-words">{ticket.title}</span>
              <span className="flex flex-wrap gap-2">
                <TicketStatusBadge status={ticket.status} />
                <SeverityBadge severity={ticket.severity} />
                <TicketSlaSummary sla={ticket.sla} />
              </span>
              <span className="text-sm">
                {t('assignee')}: {person(ticket.assignee, t('unassigned'))}
              </span>
              {ticket.project === null ? null : (
                <span className="text-sm text-muted-foreground">
                  {ticket.project.code} · {ticket.project.name}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
