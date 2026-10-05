'use client';

import {
  CalendarIcon,
  CheckCircle2Icon,
  CircleDashedIcon,
  CircleDotIcon,
  ClockIcon,
  FileTextIcon,
  HomeIcon,
  KeyRoundIcon,
  LaptopIcon,
  MinusCircleIcon,
  PlaneIcon,
  ShoppingCartIcon,
  UsersIcon,
  WrenchIcon,
  XCircleIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { useDateFormat } from '../lib/format';
import { useLocalized, useRequestHistory } from '../lib/requests';
import type {
  FormField,
  FormValue,
  RequestDetail,
  RequestStatus,
  RequestSummary,
  RequestTypeIcon,
  StepState,
} from '../lib/requests';
import { EmptyState, ErrorState, ListSkeleton } from './states';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

const STATUS_TONES: Readonly<Record<RequestStatus, Tone>> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
  IN_FULFILLMENT: 'warning',
  COMPLETED: 'success',
};

export function RequestStatusBadge({ status }: { readonly status: RequestStatus }) {
  const t = useTranslations('requests.statuses');
  return (
    <Badge tone={STATUS_TONES[status]} data-testid="request-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

const TYPE_ICONS: Readonly<Record<RequestTypeIcon, LucideIcon>> = {
  calendar: CalendarIcon,
  home: HomeIcon,
  laptop: LaptopIcon,
  key: KeyRoundIcon,
  'shopping-cart': ShoppingCartIcon,
  plane: PlaneIcon,
  'file-text': FileTextIcon,
  clock: ClockIcon,
  wrench: WrenchIcon,
  users: UsersIcon,
};

export function RequestTypeIconView({
  icon,
  className,
}: {
  readonly icon: RequestTypeIcon;
  readonly className?: string;
}) {
  const Icon = TYPE_ICONS[icon];
  return <Icon aria-hidden="true" className={className ?? 'size-5'} />;
}

interface PersonRef {
  readonly name: string;
  readonly active: boolean;
}

export function usePersonName(): (person: PersonRef | null) => string {
  const t = useTranslations('requests');
  return (person) => {
    if (person === null) return t('none');
    return person.active ? person.name : t('inactivePerson', { name: person.name });
  };
}

export function useDateSpan(): (startsOn: string | null, endsOn: string | null) => string | null {
  const { date } = useDateFormat();
  return (startsOn, endsOn) => {
    if (startsOn === null) return null;
    return endsOn === null || endsOn === startsOn ? date(startsOn) : `${date(startsOn)} – ${date(endsOn)}`;
  };
}

/** A table from 768 px, cards below (UI_UX.md §2). */
export function RequestList({
  requests,
  label,
  showRequester,
}: {
  readonly requests: readonly RequestSummary[];
  readonly label: string;
  readonly showRequester: boolean;
}) {
  const t = useTranslations('requests');
  const localized = useLocalized();
  const person = usePersonName();
  const span = useDateSpan();
  const { dateTime } = useDateFormat();
  return (
    <>
      <Card className="hidden md:block">
        <Table aria-label={label}>
          <thead>
            <TableRow>
              <TableHead>{t('request')}</TableHead>
              <TableHead>{t('status')}</TableHead>
              {showRequester ? <TableHead>{t('requester')}</TableHead> : null}
              <TableHead>{t('currentStep')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('dates')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('updated')}</TableHead>
            </TableRow>
          </thead>
          <tbody>
            {requests.map((item) => (
              <TableRow key={item.id} data-testid="request-row">
                <TableCell>
                  <Link
                    href={`/requests/${item.id}`}
                    className="flex items-center gap-2 font-medium underline-offset-4 hover:underline"
                  >
                    <RequestTypeIconView
                      icon={item.requestType.icon}
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="text-muted-foreground">{item.key}</span>
                    {localized(item.requestType.name)}
                  </Link>
                </TableCell>
                <TableCell>
                  <RequestStatusBadge status={item.status} />
                </TableCell>
                {showRequester ? <TableCell>{person(item.requester)}</TableCell> : null}
                <TableCell>{item.currentStep === null ? t('none') : localized(item.currentStep.name)}</TableCell>
                <TableCell className="hidden text-sm lg:table-cell">
                  {span(item.startsOn, item.endsOn) ?? t('none')}
                </TableCell>
                <TableCell className="hidden text-sm lg:table-cell">
                  <time dateTime={item.updatedAt}>{dateTime(item.updatedAt)}</time>
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-3 md:hidden" aria-label={label}>
        {requests.map((item) => (
          <li key={item.id} data-testid="request-card">
            <Link href={`/requests/${item.id}`} className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-accent">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <RequestTypeIconView icon={item.requestType.icon} className="size-4" />
                {item.key}
              </span>
              <span className="font-medium">{localized(item.requestType.name)}</span>
              <span className="flex flex-wrap gap-2">
                <RequestStatusBadge status={item.status} />
              </span>
              {showRequester ? <span className="text-sm">{person(item.requester)}</span> : null}
              {item.currentStep === null ? null : (
                <span className="text-sm text-muted-foreground">
                  {t('currentStep')}: {localized(item.currentStep.name)}
                </span>
              )}
              {span(item.startsOn, item.endsOn) === null ? null : (
                <span className="text-sm text-muted-foreground">{span(item.startsOn, item.endsOn)}</span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Read-only rendering of submitted values with the labels of the pinned form version. */
export function FormDataView({
  fields,
  data,
  memberNames,
  projectNames,
}: {
  readonly fields: readonly FormField[];
  readonly data: RequestDetail['formData'];
  readonly memberNames?: Readonly<Record<string, string>>;
  readonly projectNames?: Readonly<Record<string, string>>;
}) {
  const t = useTranslations('requests');
  const localized = useLocalized();
  const { date } = useDateFormat();
  const display = (field: FormField, value: FormValue): string => {
    if (typeof value === 'boolean') return value ? t('yes') : t('no');
    if (typeof value === 'number') {
      return field.type === 'money' ? `${value.toLocaleString()} ${field.currency}` : value.toLocaleString();
    }
    if (Array.isArray(value)) {
      return field.type === 'multiselect'
        ? value
            .map((item) => localized(field.options.find((option) => option.value === item)?.label) || item)
            .join(', ')
        : value.join(', ');
    }
    if (typeof value === 'object') return `${date(value.start)} – ${date(value.end)}`;
    if (field.type === 'select')
      return localized(field.options.find((option) => option.value === value)?.label) || value;
    if (field.type === 'date') return date(value);
    if (field.type === 'member') return memberNames?.[value] ?? t('memberRef');
    if (field.type === 'project') return projectNames?.[value] ?? t('projectRef');
    return value;
  };
  const rows = fields.filter(
    (field) => field.type !== 'info' && data[field.key] !== undefined && data[field.key] !== null,
  );
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noValues')}</p>;
  }
  return (
    <dl className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]" data-testid="request-form-data">
      {rows.map((field) => {
        const value = data[field.key];
        return value === undefined || value === null ? null : (
          <div key={field.key} className="contents">
            <dt className="text-sm text-muted-foreground">{localized(field.label)}</dt>
            <dd className="text-sm break-words whitespace-pre-wrap" data-field={field.key}>
              {display(field, value)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

const STEP_ICONS: Readonly<Record<StepState, LucideIcon>> = {
  NOT_REACHED: CircleDashedIcon,
  ACTIVE: CircleDotIcon,
  COMPLETED: CheckCircle2Icon,
  SKIPPED: MinusCircleIcon,
  REJECTED: XCircleIcon,
  CANCELLED: MinusCircleIcon,
};

/** The route of the pinned workflow version, with each step's approvals (UI_UX: text, not color alone). */
export function StepTimeline({ request }: { readonly request: RequestDetail }) {
  const t = useTranslations('requests');
  const localized = useLocalized();
  const person = usePersonName();
  const { dateTime } = useDateFormat();
  return (
    <ol className="flex flex-col gap-4" aria-label={t('detail.route')} data-testid="request-steps">
      {request.steps.map((step) => {
        const Icon = STEP_ICONS[step.state];
        return (
          <li key={step.order} className="flex gap-3" data-testid="request-step" data-state={step.state}>
            <Icon
              aria-hidden="true"
              className={`mt-0.5 size-5 shrink-0 ${
                step.state === 'COMPLETED'
                  ? 'text-success'
                  : step.state === 'REJECTED'
                    ? 'text-destructive'
                    : step.state === 'ACTIVE'
                      ? 'text-warning'
                      : 'text-muted-foreground'
              }`}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {localized(step.name)}
                <Badge>{t(`stepStates.${step.state}`)}</Badge>
                {step.kind === 'APPROVAL' && step.approvals.length > 1 ? (
                  <Badge>{t(`modes.${step.mode}`)}</Badge>
                ) : null}
                {step.kind === 'FULFILLMENT' ? <Badge>{t('fulfillmentStep')}</Badge> : null}
              </p>
              {step.unassigned ? <p className="text-sm text-destructive">{t('detail.unassigned')}</p> : null}
              {step.approvals.length === 0 ? null : (
                <ul className="flex flex-col gap-1 text-sm">
                  {step.approvals.map((approval) => (
                    <li key={approval.id} data-testid="request-approval" data-status={approval.status}>
                      <span className="font-medium">{person(approval.approver)}</span>
                      {' · '}
                      {t(`approvalStatuses.${approval.status}`)}
                      {approval.delegated && approval.decidedBy !== null
                        ? ` · ${t('detail.decidedByDelegate', { name: person(approval.decidedBy) })}`
                        : ''}
                      {approval.decidedAt === null ? (
                        approval.dueAt === null ? null : (
                          <span className="text-muted-foreground">
                            {' · '}
                            {t('detail.dueAt', { date: dateTime(approval.dueAt) })}
                          </span>
                        )
                      ) : (
                        <span className="text-muted-foreground">
                          {' · '}
                          <time dateTime={approval.decidedAt}>{dateTime(approval.decidedAt)}</time>
                        </span>
                      )}
                      {approval.comment === null ? null : (
                        <p
                          className="mt-1 rounded-md bg-muted/50 p-2 whitespace-pre-wrap"
                          data-testid="approval-comment"
                        >
                          {approval.comment}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function RequestHistory({ requestId }: { readonly requestId: string }) {
  const t = useTranslations('requests');
  const common = useTranslations('common');
  const person = usePersonName();
  const { dateTime } = useDateFormat();
  const history = useRequestHistory(requestId);
  const rows = history.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.history')}</CardTitle>
      </CardHeader>
      <CardContent>
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
          <EmptyState message={t('detail.noHistory')} />
        ) : (
          <ol className="flex flex-col gap-3" data-testid="request-history">
            {rows.map((event) => (
              <li key={event.id} className="flex flex-col gap-0.5 text-sm" data-event={event.type}>
                <span>
                  <span className="font-medium">
                    {event.actor === null ? t('history.system') : person(event.actor)}
                  </span>{' '}
                  {t(`history.${event.type}`, { subject: event.subject === null ? '' : person(event.subject) })}
                </span>
                {event.note === null ? null : (
                  <span className="rounded-md bg-muted/50 p-2 whitespace-pre-wrap">{event.note}</span>
                )}
                <time dateTime={event.createdAt} className="text-xs text-muted-foreground">
                  {dateTime(event.createdAt)}
                </time>
              </li>
            ))}
          </ol>
        )}
        {history.hasNextPage ? (
          <Button
            variant="outline"
            className="mt-3"
            disabled={history.isFetchingNextPage}
            onClick={() => {
              void history.fetchNextPage();
            }}
          >
            {history.isFetchingNextPage ? common('loading') : common('loadMore')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
