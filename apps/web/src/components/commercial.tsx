'use client';

import { AlertTriangleIcon, CheckCircle2Icon, ClockIcon, DownloadIcon, FileTextIcon, LockIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ReactNode, SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, NativeSelect, Textarea } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { api, ApiError, request } from '../lib/api';
import {
  CLASSIFICATIONS,
  DOCUMENT_CATEGORIES,
  GUARANTEE_TYPES,
  amountOrUndefined,
  useCommercialAction,
  useParentDocuments,
  useParentGuarantees,
  useTimeline,
} from '../lib/commercial';
import type {
  CommercialDocument,
  CommercialHealth,
  ContractStatus,
  ContractSummary,
  CorporateDocumentSummary,
  DocumentValidity,
  Guarantee,
  GuaranteeStatus,
  MilestoneStatus,
  Money,
  ObligationStatus,
  RequirementStatus,
  TenderStatus,
  TenderSummary,
} from '../lib/commercial';
import { useDateFormat } from '../lib/format';
import { uploadAttachment } from '../lib/uploads';
import { Field, FormError, StatusMessage, fieldErrorsOf } from './form';
import { EmptyState, ErrorState, ListSkeleton, useErrorMessage } from './states';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';

/** Business documents the server accepts for commercial files (mirrors the attachment policy). */
export const COMMERCIAL_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'text/csv',
] as const;
export const COMMERCIAL_FILE_MAX_BYTES = 25 * 1024 * 1024;

// ---- Money and people ----

/** A decimal amount with its currency, grouped but never converted or rounded (ADR-0026). */
export function formatMoney(money: Money): string {
  const [integer = '0', fraction] = money.amount.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${fraction === undefined ? '' : `.${fraction}`} ${money.currency}`;
}

/** Amounts stay left-to-right inside Arabic text. */
export function MoneyText({ money }: { readonly money: Money | undefined }) {
  const t = useTranslations('commercial');
  if (money === undefined) {
    return <span className="text-muted-foreground">{t('money.hidden')}</span>;
  }
  return (
    <bdi dir="ltr" className="tabular-nums" data-testid="money">
      {formatMoney(money)}
    </bdi>
  );
}

interface PersonRef {
  readonly name: string;
  readonly active: boolean;
}

export function useCommercialPerson(): (person: PersonRef | null | undefined, fallback?: string) => string {
  const t = useTranslations('commercial');
  return (person, fallback) => {
    if (person === null || person === undefined) {
      return fallback ?? t('none');
    }
    return person.active ? person.name : t('inactivePerson', { name: person.name });
  };
}

// ---- Badges (text plus tone, never color alone) ----

const TENDER_TONES: Readonly<Record<TenderStatus, Tone>> = {
  DRAFT: 'neutral',
  NEW: 'warning',
  UNDER_REVIEW: 'neutral',
  BID_DECISION_PENDING: 'warning',
  NO_BID: 'neutral',
  PREPARING: 'neutral',
  INTERNAL_REVIEW: 'warning',
  READY_FOR_SUBMISSION: 'success',
  SUBMITTED: 'neutral',
  CLARIFICATION: 'warning',
  AWARDED: 'success',
  LOST: 'danger',
  CANCELLED: 'neutral',
  ARCHIVED: 'neutral',
};

export function TenderStatusBadge({ status }: { readonly status: TenderStatus }) {
  const t = useTranslations('commercial.tenderStatuses');
  return (
    <Badge tone={TENDER_TONES[status]} data-testid="tender-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

const CONTRACT_TONES: Readonly<Record<ContractStatus, Tone>> = {
  DRAFT: 'neutral',
  UNDER_REVIEW: 'neutral',
  AWAITING_SIGNATURE: 'warning',
  ACTIVE: 'success',
  RENEWAL_REVIEW: 'warning',
  SUSPENDED: 'danger',
  EXPIRED: 'danger',
  TERMINATED: 'neutral',
  CLOSED: 'neutral',
};

export function ContractStatusBadge({ status }: { readonly status: ContractStatus }) {
  const t = useTranslations('commercial.contractStatuses');
  return (
    <Badge tone={CONTRACT_TONES[status]} data-testid="contract-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

const HEALTH_TONES: Readonly<Record<CommercialHealth, Tone>> = {
  HEALTHY: 'success',
  NEEDS_ATTENTION: 'warning',
  AT_RISK: 'danger',
  CRITICAL: 'danger',
};

export function HealthBadge({ health }: { readonly health: CommercialHealth }) {
  const t = useTranslations('commercial');
  const Icon = health === 'HEALTHY' ? CheckCircle2Icon : AlertTriangleIcon;
  return (
    <Badge tone={HEALTH_TONES[health]} data-testid="contract-health" data-health={health}>
      <Icon aria-hidden="true" className="size-3" />
      <span className="sr-only">{t('fields.health')}: </span>
      {t(`healths.${health}`)}
    </Badge>
  );
}

export function ReadinessBadge({ readiness }: { readonly readiness: TenderSummary['readiness'] }) {
  const t = useTranslations('commercial.readiness');
  const tone: Tone = readiness.state === 'READY' ? 'success' : readiness.state === 'NOT_READY' ? 'warning' : 'neutral';
  return (
    <Badge tone={tone} data-testid="tender-readiness" data-state={readiness.state}>
      {readiness.percent === null ? t('noMandatory') : t('percent', { percent: readiness.percent })}
    </Badge>
  );
}

const VALIDITY_TONES: Readonly<Record<DocumentValidity, Tone>> = {
  VALID: 'success',
  EXPIRING: 'warning',
  EXPIRED: 'danger',
  NO_EXPIRY: 'neutral',
  NO_VERSION: 'neutral',
};

export function ValidityBadge({ validity }: { readonly validity: DocumentValidity }) {
  const t = useTranslations('commercial.validities');
  return (
    <Badge tone={VALIDITY_TONES[validity]} data-testid="document-validity" data-validity={validity}>
      {validity === 'EXPIRED' || validity === 'EXPIRING' ? (
        <AlertTriangleIcon aria-hidden="true" className="size-3" />
      ) : null}
      {t(validity)}
    </Badge>
  );
}

const GUARANTEE_TONES: Readonly<Record<GuaranteeStatus, Tone>> = {
  ACTIVE: 'success',
  EXPIRING: 'warning',
  EXPIRED: 'danger',
  RELEASED: 'neutral',
  CANCELLED: 'neutral',
};

export function GuaranteeStatusBadge({ status }: { readonly status: GuaranteeStatus }) {
  const t = useTranslations('commercial.guaranteeStatuses');
  return (
    <Badge tone={GUARANTEE_TONES[status]} data-testid="guarantee-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

const OBLIGATION_TONES: Readonly<Record<ObligationStatus, Tone>> = {
  UPCOMING: 'neutral',
  IN_PROGRESS: 'neutral',
  COMPLETED: 'success',
  OVERDUE: 'danger',
  WAIVED: 'neutral',
  CANCELLED: 'neutral',
};

export function ObligationStatusBadge({ status }: { readonly status: ObligationStatus }) {
  const t = useTranslations('commercial.obligationStatuses');
  return (
    <Badge tone={OBLIGATION_TONES[status]} data-testid="obligation-status" data-status={status}>
      {status === 'OVERDUE' ? <ClockIcon aria-hidden="true" className="size-3" /> : null}
      {t(status)}
    </Badge>
  );
}

const MILESTONE_TONES: Readonly<Record<MilestoneStatus, Tone>> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'neutral',
  SUBMITTED: 'warning',
  APPROVED: 'success',
  COMPLETED: 'success',
  OVERDUE: 'danger',
  CANCELLED: 'neutral',
};

export function MilestoneStatusBadge({ status }: { readonly status: MilestoneStatus }) {
  const t = useTranslations('commercial.milestoneStatuses');
  return (
    <Badge tone={MILESTONE_TONES[status]} data-testid="milestone-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

const REQUIREMENT_TONES: Readonly<Record<RequirementStatus, Tone>> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'neutral',
  READY_FOR_REVIEW: 'warning',
  CHANGES_REQUIRED: 'danger',
  APPROVED: 'success',
  NOT_APPLICABLE: 'neutral',
  BLOCKED: 'danger',
};

export function RequirementStatusBadge({ status }: { readonly status: RequirementStatus }) {
  const t = useTranslations('commercial.requirementStatuses');
  return (
    <Badge tone={REQUIREMENT_TONES[status]} data-testid="requirement-status" data-status={status}>
      {t(status)}
    </Badge>
  );
}

// ---- Layout helpers ----

/** Label/value pairs as a definition list (stacks on phones). */
export function Facts({ items }: { readonly items: readonly (readonly [string, ReactNode] | null)[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items
        .filter((item): item is readonly [string, ReactNode] => item !== null)
        .map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm break-words">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function Section({
  title,
  actions,
  children,
}: {
  readonly title: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold">
          {title}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** A button opening a dialog whose form closes it when done. */
export function ActionDialog({
  label,
  title,
  variant = 'outline',
  disabled,
  testId,
  children,
}: {
  readonly label: string;
  readonly title: string;
  readonly variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  readonly disabled?: boolean;
  readonly testId?: string;
  readonly children: (close: () => void) => ReactNode;
}) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={variant}
        disabled={disabled}
        data-testid={testId}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
      {open ? (
        <DialogContent title={title} closeLabel={t('close')}>
          {children(() => {
            setOpen(false);
          })}
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  errorCode,
  optional,
  allowEmpty,
  emptyLabel,
}: {
  readonly label: string;
  readonly value: T | '';
  readonly options: readonly (readonly [T, string])[];
  readonly onChange: (value: T | '') => void;
  readonly errorCode?: string | undefined;
  readonly optional?: boolean;
  readonly allowEmpty?: boolean;
  readonly emptyLabel?: string;
}) {
  const t = useTranslations('common');
  return (
    <Field label={label} errorCode={errorCode} optional={optional ?? false}>
      {(control) => (
        <NativeSelect
          {...control}
          value={value}
          onChange={(event) => {
            onChange(options.find(([option]) => option === event.target.value)?.[0] ?? '');
          }}
        >
          {allowEmpty === true ? <option value="">{emptyLabel ?? t('none')}</option> : null}
          {options.map(([option, text]) => (
            <option key={option} value={option}>
              {text}
            </option>
          ))}
        </NativeSelect>
      )}
    </Field>
  );
}

/** Calendar date in the organization's sense; overdue dates carry a text cue as well as color. */
export function DueDate({ date, overdue }: { readonly date: string | null; readonly overdue?: boolean }) {
  const t = useTranslations('commercial');
  const { date: formatDate } = useDateFormat();
  if (date === null) {
    return <span className="text-muted-foreground">{t('noDate')}</span>;
  }
  return (
    <span className={overdue === true ? 'font-medium text-destructive' : undefined}>
      <time dateTime={date}>{formatDate(date)}</time>
      {overdue === true ? <span className="ms-1">({t('overdue')})</span> : null}
    </span>
  );
}

// ---- Lists ----

export function TenderList({ tenders, label }: { readonly tenders: readonly TenderSummary[]; readonly label: string }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime } = useDateFormat();
  const showValue = tenders.some((tender) => tender.estimatedValue !== undefined);
  const deadline = (tender: TenderSummary) =>
    tender.submissionDeadlineAt === null ? (
      <span className="text-muted-foreground">{t('noDeadline')}</span>
    ) : (
      <time dateTime={tender.submissionDeadlineAt}>{dateTime(tender.submissionDeadlineAt)}</time>
    );
  return (
    <>
      <Card className="hidden md:block">
        <Table aria-label={label}>
          <thead>
            <TableRow>
              <TableHead>{t('fields.tender')}</TableHead>
              <TableHead>{t('fields.status')}</TableHead>
              <TableHead>{t('fields.deadline')}</TableHead>
              <TableHead>{t('fields.readiness')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('fields.owner')}</TableHead>
              {showValue ? <TableHead className="hidden lg:table-cell">{t('fields.estimatedValue')}</TableHead> : null}
            </TableRow>
          </thead>
          <tbody>
            {tenders.map((tender) => (
              <TableRow key={tender.id} data-testid="tender-row">
                <TableCell className="max-w-80">
                  <Link href={`/tenders/${tender.id}`} className="font-medium underline-offset-4 hover:underline">
                    <span className="me-2 text-muted-foreground">{tender.key}</span>
                    {tender.title}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {tender.customer?.name ?? tender.counterpartyName ?? t('noCustomer')}
                  </span>
                  <TenderAlerts alerts={tender.alerts} />
                </TableCell>
                <TableCell>
                  <TenderStatusBadge status={tender.status} />
                </TableCell>
                <TableCell className="text-sm">{deadline(tender)}</TableCell>
                <TableCell>
                  <ReadinessBadge readiness={tender.readiness} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">{person(tender.owner)}</TableCell>
                {showValue ? (
                  <TableCell className="hidden lg:table-cell">
                    <MoneyText money={tender.estimatedValue} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-3 md:hidden" aria-label={label}>
        {tenders.map((tender) => (
          <li key={tender.id} data-testid="tender-card">
            <Link href={`/tenders/${tender.id}`} className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-accent">
              <span className="text-sm text-muted-foreground">{tender.key}</span>
              <span className="font-medium break-words">{tender.title}</span>
              <span className="flex flex-wrap gap-2">
                <TenderStatusBadge status={tender.status} />
                <ReadinessBadge readiness={tender.readiness} />
              </span>
              <span className="text-sm">
                {t('fields.deadline')}: {deadline(tender)}
              </span>
              <span className="text-sm text-muted-foreground">
                {t('fields.owner')}: {person(tender.owner)}
              </span>
              <TenderAlerts alerts={tender.alerts} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function TenderAlerts({ alerts }: { readonly alerts: TenderSummary['alerts'] }) {
  const t = useTranslations('commercial.alerts');
  if (alerts.length === 0) {
    return null;
  }
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {alerts.map((alert) => (
        <Badge
          key={alert}
          tone={alert === 'DEADLINE_PASSED' || alert === 'DEADLINE_TOMORROW' ? 'danger' : 'warning'}
          data-testid="tender-alert"
        >
          <AlertTriangleIcon aria-hidden="true" className="size-3" />
          {t(alert)}
        </Badge>
      ))}
    </span>
  );
}

export function ContractList({
  contracts,
  label,
}: {
  readonly contracts: readonly ContractSummary[];
  readonly label: string;
}) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const showValue = contracts.some((contract) => contract.currentValue !== undefined);
  return (
    <>
      <Card className="hidden md:block">
        <Table aria-label={label}>
          <thead>
            <TableRow>
              <TableHead>{t('fields.contract')}</TableHead>
              <TableHead>{t('fields.status')}</TableHead>
              <TableHead>{t('fields.health')}</TableHead>
              <TableHead>{t('fields.currentExpiry')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('fields.owner')}</TableHead>
              {showValue ? <TableHead className="hidden lg:table-cell">{t('fields.currentValue')}</TableHead> : null}
            </TableRow>
          </thead>
          <tbody>
            {contracts.map((contract) => (
              <TableRow key={contract.id} data-testid="contract-row">
                <TableCell className="max-w-80">
                  <Link href={`/contracts/${contract.id}`} className="font-medium underline-offset-4 hover:underline">
                    <span className="me-2 text-muted-foreground">{contract.key}</span>
                    {contract.title}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    {[contract.customer?.name ?? contract.counterpartyName, contract.project?.code]
                      .filter((part): part is string => part !== null && part !== undefined)
                      .join(' · ') || t('noCustomer')}
                  </span>
                </TableCell>
                <TableCell>
                  <ContractStatusBadge status={contract.status} />
                </TableCell>
                <TableCell>
                  <HealthBadge health={contract.health} />
                </TableCell>
                <TableCell className="text-sm">
                  <DueDate date={contract.currentExpiryDate} />
                  {contract.expiring ? <span className="ms-1 text-xs text-warning">({t('expiringSoon')})</span> : null}
                </TableCell>
                <TableCell className="hidden lg:table-cell">{person(contract.owner)}</TableCell>
                {showValue ? (
                  <TableCell className="hidden lg:table-cell">
                    <MoneyText money={contract.currentValue} />
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-3 md:hidden" aria-label={label}>
        {contracts.map((contract) => (
          <li key={contract.id} data-testid="contract-card">
            <Link
              href={`/contracts/${contract.id}`}
              className="flex flex-col gap-2 rounded-lg border p-4 hover:bg-accent"
            >
              <span className="text-sm text-muted-foreground">{contract.key}</span>
              <span className="font-medium break-words">{contract.title}</span>
              <span className="flex flex-wrap gap-2">
                <ContractStatusBadge status={contract.status} />
                <HealthBadge health={contract.health} />
              </span>
              <span className="text-sm">
                {t('fields.currentExpiry')}: <DueDate date={contract.currentExpiryDate} />
              </span>
              <span className="text-sm text-muted-foreground">
                {t('fields.owner')}: {person(contract.owner)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export function CorporateDocumentList({
  documents,
  label,
  onOpen,
}: {
  readonly documents: readonly CorporateDocumentSummary[];
  readonly label: string;
  readonly onOpen: (id: string) => void;
}) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const title = (document: CorporateDocumentSummary) => (
    <>
      {document.classification === 'GENERAL' ? null : (
        <LockIcon aria-label={t(`classifications.${document.classification}`)} className="me-1 inline size-3" />
      )}
      {document.title}
    </>
  );
  return (
    <>
      <Card className="hidden md:block">
        <Table aria-label={label}>
          <thead>
            <TableRow>
              <TableHead>{t('fields.document')}</TableHead>
              <TableHead>{t('fields.documentType')}</TableHead>
              <TableHead>{t('fields.validity')}</TableHead>
              <TableHead>{t('fields.expiryDate')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('fields.owner')}</TableHead>
            </TableRow>
          </thead>
          <tbody>
            {documents.map((document) => (
              <TableRow key={document.id} data-testid="corporate-document-row">
                <TableCell className="max-w-80">
                  <button
                    type="button"
                    className="text-start font-medium underline-offset-4 hover:underline"
                    onClick={() => {
                      onOpen(document.id);
                    }}
                  >
                    {title(document)}
                  </button>
                  {document.documentNumber === null ? null : (
                    <span className="block text-xs text-muted-foreground">{document.documentNumber}</span>
                  )}
                </TableCell>
                <TableCell className="text-sm">{t(`documentTypes.${document.documentType}`)}</TableCell>
                <TableCell>
                  <ValidityBadge validity={document.validity} />
                </TableCell>
                <TableCell className="text-sm">
                  <DueDate date={document.currentExpiryDate} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">{person(document.owner)}</TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      </Card>
      <ul className="flex flex-col gap-3 md:hidden" aria-label={label}>
        {documents.map((document) => (
          <li key={document.id} data-testid="corporate-document-card">
            <button
              type="button"
              className="flex w-full flex-col gap-2 rounded-lg border p-4 text-start hover:bg-accent"
              onClick={() => {
                onOpen(document.id);
              }}
            >
              <span className="font-medium break-words">{title(document)}</span>
              <span className="text-sm text-muted-foreground">{t(`documentTypes.${document.documentType}`)}</span>
              <span className="flex flex-wrap gap-2">
                <ValidityBadge validity={document.validity} />
              </span>
              <span className="text-sm">
                {t('fields.expiryDate')}: <DueDate date={document.currentExpiryDate} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---- Timeline ----

const EVENT_KEYS = [
  'created',
  'updated',
  'owner_changed',
  'deadline_changed',
  'status_changed',
  'bid_decided',
  'submitted',
  'submission_corrected',
  'awarded',
  'loss_recorded',
  'addendum_recorded',
  'clarification_opened',
  'contract_created',
  'requirement_added',
  'requirement_updated',
  'requirement_removed',
  'requirement_approved',
  'requirement_status_changed',
  'requirement_document_linked',
  'requirement_document_unlinked',
  'review_requested',
  'review_decided',
  'review_completed',
  'document_added',
  'document_version_added',
  'guarantee_added',
  'guarantee_updated',
  'guarantee_released',
  'guarantee_cancelled',
  'project_linked',
  'project_unlinked',
  'activated',
  'renewal_review_started',
  'renewal_action_recorded',
  'amendment_created',
  'amendment_effective',
  'value_changed',
  'expiry_changed',
  'obligation_created',
  'obligation_updated',
  'obligation_cancelled',
  'obligation_completed',
  'obligation_waived',
  'milestone_created',
  'milestone_updated',
  'milestone_completed',
  'milestone_approved',
  'milestone_status_changed',
] as const;
type EventKey = (typeof EVENT_KEYS)[number];

export function Timeline({ parent, id }: { readonly parent: 'tenders' | 'contracts'; readonly id: string }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime } = useDateFormat();
  const events = useTimeline(parent, id);
  if (events.isPending) {
    return <ListSkeleton rows={4} />;
  }
  if (events.isError) {
    return (
      <ErrorState
        error={events.error}
        onRetry={() => {
          void events.refetch();
        }}
      />
    );
  }
  const rows = events.data.pages.flatMap((page) => page.data);
  if (rows.length === 0) {
    return <EmptyState message={t('timeline.empty')} />;
  }
  const describe = (type: string) => {
    const suffix = type.split('.').slice(1).join('_');
    const key = EVENT_KEYS.find((candidate) => candidate === suffix);
    return key === undefined ? type : t(`events.${key satisfies EventKey}`);
  };
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-3 border-s ps-4" data-testid="commercial-timeline">
        {rows.map((event) => {
          const from = typeof event.params.from === 'string' ? event.params.from : null;
          const to = typeof event.params.to === 'string' ? event.params.to : null;
          return (
            <li key={event.id} className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">{describe(event.type)}</span>
              {from !== null && to !== null ? (
                <span className="text-xs text-muted-foreground">{t('timeline.change', { from, to })}</span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {person(event.actor, t('timeline.system'))} ·{' '}
                <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
              </span>
            </li>
          );
        })}
      </ol>
      {events.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={events.isFetchingNextPage}
          onClick={() => {
            void events.fetchNextPage();
          }}
        >
          {events.isFetchingNextPage ? t('loading') : t('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

// ---- Files ----

type UploadPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'uploading'; readonly percent: number }
  | { readonly phase: 'verifying' }
  | { readonly phase: 'error'; readonly message: string };

/**
 * One file chooser for a document version: uploads to the given owner and hands the verified
 * attachment id to `onUploaded` (which registers the version).
 */
export function VersionUpload({
  ownerType,
  ownerId,
  label,
  onUploaded,
}: {
  readonly ownerType: 'COMMERCIAL_DOCUMENT' | 'CORPORATE_DOCUMENT';
  readonly ownerId: string;
  readonly label: string;
  readonly onUploaded: (attachmentId: string) => Promise<void>;
}) {
  const t = useTranslations('commercial.files');
  const errorMessage = useErrorMessage();
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadPhase>({ phase: 'idle' });
  const upload = async (file: File) => {
    if (!(COMMERCIAL_FILE_TYPES as readonly string[]).includes(file.type)) {
      setState({ phase: 'error', message: t('badType') });
      return;
    }
    if (file.size > COMMERCIAL_FILE_MAX_BYTES) {
      setState({ phase: 'error', message: t('tooLarge') });
      return;
    }
    setState({ phase: 'uploading', percent: 0 });
    try {
      const attachmentId = await uploadAttachment(ownerType, ownerId, file, {
        onProgress: (percent) => {
          setState({ phase: 'uploading', percent });
        },
        onVerifying: () => {
          setState({ phase: 'verifying' });
        },
      });
      if (attachmentId === null) {
        setState({ phase: 'error', message: t('rejected') });
        return;
      }
      await onUploaded(attachmentId);
      setState({ phase: 'idle' });
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof ApiError && error.code === 'UPLOAD_FAILED' ? t('uploadFailed') : errorMessage(error),
      });
    } finally {
      if (inputRef.current !== null) {
        inputRef.current.value = '';
      }
    }
  };
  const busy = state.phase === 'uploading' || state.phase === 'verifying';
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('hint')}
      </p>
      <input
        ref={inputRef}
        id={id}
        type="file"
        accept={COMMERCIAL_FILE_TYPES.join(',')}
        aria-describedby={`${id}-hint`}
        disabled={busy}
        data-testid="version-upload"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) {
            void upload(file);
          }
        }}
        className="text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:bg-background file:px-3"
      />
      {state.phase === 'uploading' ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('progress', { percent: state.percent })}
        </p>
      ) : null}
      {state.phase === 'verifying' ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('verifying')}
        </p>
      ) : null}
      {state.phase === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

/** Asks the API for a short-lived download URL (authorized per request) and follows it. */
export function DownloadButton({
  attachmentId,
  filename,
}: {
  readonly attachmentId: string;
  readonly filename: string;
}) {
  const t = useTranslations('commercial.files');
  const errorMessage = useErrorMessage();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          request(() => api.GET('/api/v1/attachments/{id}/download-url', { params: { path: { id: attachmentId } } }))
            .then((result) => {
              window.location.assign(result.data.url);
            })
            .catch((failure: unknown) => {
              setError(errorMessage(failure));
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <DownloadIcon aria-hidden="true" />
        {t('download')}
        <span className="sr-only">{filename}</span>
      </Button>
      {error === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </span>
  );
}

// ---- Tender/contract documents ----

export function DocumentsPanel({
  parent,
  id,
  canManage,
}: {
  readonly parent: 'tenders' | 'contracts';
  readonly id: string;
  readonly canManage: boolean;
}) {
  const t = useTranslations('commercial');
  const documents = useParentDocuments(parent, id);
  return (
    <Section
      title={t('documents.title')}
      actions={
        canManage ? (
          <ActionDialog label={t('documents.add')} title={t('documents.add')} testId="add-document">
            {(close) => <CreateDocumentForm parent={parent} id={id} onDone={close} />}
          </ActionDialog>
        ) : undefined
      }
    >
      {documents.isPending ? (
        <ListSkeleton rows={3} />
      ) : documents.isError ? (
        <ErrorState
          error={documents.error}
          onRetry={() => {
            void documents.refetch();
          }}
        />
      ) : documents.data.items.length === 0 ? (
        <EmptyState message={t('documents.empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="commercial-documents">
          {documents.data.items.map((document) => (
            <DocumentItem key={document.id} document={document} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function DocumentItem({ document }: { readonly document: CommercialDocument }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime } = useDateFormat();
  const action = useCommercialAction();
  const current = document.versions.find((version) => version.isCurrent) ?? null;
  const previous = document.versions.filter((version) => !version.isCurrent);
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-4" data-testid="commercial-document">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex items-center gap-2 font-medium break-words">
            <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {document.title}
          </span>
          <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{t(`documentCategories.${document.category}`)}</span>
            <span>·</span>
            <span>{t(`classifications.${document.classification}`)}</span>
            {current === null ? null : (
              <>
                <span>·</span>
                <span>{t('documents.version', { number: current.versionNumber })}</span>
              </>
            )}
          </span>
        </div>
        {current === null ? (
          <Badge>{t('documents.noVersion')}</Badge>
        ) : (
          <DownloadButton attachmentId={current.attachmentId} filename={current.filename} />
        )}
      </div>
      {current === null ? null : (
        <p className="text-xs text-muted-foreground">
          {current.filename} · {person(current.uploadedBy)} · {dateTime(current.uploadedAt)}
        </p>
      )}
      {previous.length === 0 ? null : (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t('documents.history', { count: previous.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-2">
            {previous.map((version) => (
              <li key={version.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs">
                  {t('documents.version', { number: version.versionNumber })} · {version.filename} ·{' '}
                  {dateTime(version.uploadedAt)}
                </span>
                <DownloadButton attachmentId={version.attachmentId} filename={version.filename} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {document.canManage ? (
        <>
          <VersionUpload
            ownerType="COMMERCIAL_DOCUMENT"
            ownerId={document.id}
            label={t('documents.uploadVersion')}
            onUploaded={async (attachmentId) => {
              await action.mutateAsync(() =>
                request(() =>
                  api.POST('/api/v1/commercial-documents/{documentId}/versions', {
                    params: { path: { documentId: document.id } },
                    body: { attachmentId },
                  }),
                ),
              );
            }}
          />
          <FormError error={action.error} />
        </>
      ) : null}
    </li>
  );
}

function CreateDocumentForm({
  parent,
  id,
  onDone,
}: {
  readonly parent: 'tenders' | 'contracts';
  readonly id: string;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<CommercialDocument['category'] | ''>(
    parent === 'tenders' ? 'SOURCE_DOCUMENTS' : 'SIGNED_CONTRACT',
  );
  const [classification, setClassification] = useState<CommercialDocument['classification'] | ''>('GENERAL');
  const errors = fieldErrorsOf(action.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (category === '') return;
    const body = {
      title: title.trim(),
      category,
      ...(classification === '' ? {} : { classification }),
    };
    action.mutate(
      () =>
        parent === 'tenders'
          ? request(() => api.POST('/api/v1/tenders/{id}/documents', { params: { path: { id } }, body }))
          : request(() => api.POST('/api/v1/contracts/{id}/documents', { params: { path: { id } }, body })),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <Field label={t('fields.title')} errorCode={errors.get('title')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={300}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        )}
      </Field>
      <SelectField
        label={t('fields.category')}
        value={category}
        options={DOCUMENT_CATEGORIES.map((value) => [value, t(`documentCategories.${value}`)] as const)}
        onChange={setCategory}
        errorCode={errors.get('category')}
      />
      <SelectField
        label={t('fields.classification')}
        value={classification}
        options={CLASSIFICATIONS.map((value) => [value, t(`classifications.${value}`)] as const)}
        onChange={setClassification}
        errorCode={errors.get('classification')}
      />
      <p className="text-xs text-muted-foreground">{t('documents.createHint')}</p>
      <Button type="submit" disabled={action.isPending || title.trim() === ''}>
        {action.isPending ? t('saving') : t('documents.add')}
      </Button>
    </form>
  );
}

// ---- Guarantees ----

export function GuaranteesPanel({
  parent,
  id,
  canManage,
}: {
  readonly parent: 'tenders' | 'contracts';
  readonly id: string;
  readonly canManage: boolean;
}) {
  const t = useTranslations('commercial');
  const guarantees = useParentGuarantees(parent, id);
  return (
    <Section
      title={t('guarantees.title')}
      actions={
        canManage ? (
          <ActionDialog label={t('guarantees.add')} title={t('guarantees.add')} testId="add-guarantee">
            {(close) => <CreateGuaranteeForm parent={parent} id={id} onDone={close} />}
          </ActionDialog>
        ) : undefined
      }
    >
      {guarantees.isPending ? (
        <ListSkeleton rows={3} />
      ) : guarantees.isError ? (
        <ErrorState
          error={guarantees.error}
          onRetry={() => {
            void guarantees.refetch();
          }}
        />
      ) : guarantees.data.length === 0 ? (
        <EmptyState message={t('guarantees.empty')} />
      ) : (
        <GuaranteeList guarantees={guarantees.data} />
      )}
    </Section>
  );
}

export function GuaranteeList({ guarantees }: { readonly guarantees: readonly Guarantee[] }) {
  return (
    <ul className="flex flex-col gap-3" data-testid="guarantees">
      {guarantees.map((guarantee) => (
        <GuaranteeItem key={guarantee.id} guarantee={guarantee} />
      ))}
    </ul>
  );
}

function GuaranteeItem({ guarantee }: { readonly guarantee: Guarantee }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const action = useCommercialAction();
  const open = guarantee.status === 'ACTIVE' || guarantee.status === 'EXPIRING' || guarantee.status === 'EXPIRED';
  const setStatus = (status: 'RELEASED' | 'CANCELLED') => {
    action.mutate(() =>
      request(() =>
        api.POST('/api/v1/guarantees/{guaranteeId}/status', {
          params: { path: { guaranteeId: guarantee.id } },
          body: { version: guarantee.version, status },
        }),
      ),
    );
  };
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-4" data-testid="guarantee">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium break-words">
            {t(`guaranteeTypes.${guarantee.type}`)} · <bdi dir="ltr">{guarantee.referenceNumber}</bdi>
          </span>
          <span className="text-xs text-muted-foreground">{guarantee.issuer}</span>
        </div>
        <GuaranteeStatusBadge status={guarantee.status} />
      </div>
      <Facts
        items={[
          [t('fields.amount'), <MoneyText key="amount" money={guarantee.amount} />],
          [
            t('fields.expiryDate'),
            <DueDate key="expiry" date={guarantee.expiryDate} overdue={guarantee.status === 'EXPIRED'} />,
          ],
          guarantee.status === 'ACTIVE' || guarantee.status === 'EXPIRING'
            ? [t('fields.daysToExpiry'), t('daysCount', { days: guarantee.daysToExpiry })]
            : null,
          [t('fields.owner'), person(guarantee.owner)],
          guarantee.beneficiary === null ? null : [t('fields.beneficiary'), guarantee.beneficiary],
        ]}
      />
      {guarantee.canManage && open ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={action.isPending}
            onClick={() => {
              setStatus('RELEASED');
            }}
          >
            {t('guarantees.release')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => {
              if (window.confirm(t('guarantees.confirmCancel'))) {
                setStatus('CANCELLED');
              }
            }}
          >
            {t('guarantees.cancel')}
          </Button>
        </div>
      ) : null}
      <FormError error={action.error} />
    </li>
  );
}

function CreateGuaranteeForm({
  parent,
  id,
  onDone,
}: {
  readonly parent: 'tenders' | 'contracts';
  readonly id: string;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [type, setType] = useState<Guarantee['type'] | ''>(
    parent === 'tenders' ? 'BID_SECURITY' : 'PERFORMANCE_GUARANTEE',
  );
  const [draft, setDraft] = useState({
    referenceNumber: '',
    issuer: '',
    beneficiary: '',
    amount: '',
    currency: 'EGP',
    issueDate: '',
    expiryDate: '',
    notes: '',
  });
  const errors = fieldErrorsOf(action.error);
  const amount = amountOrUndefined(draft.amount);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (type === '') return;
    const body = {
      type,
      referenceNumber: draft.referenceNumber.trim(),
      issuer: draft.issuer.trim(),
      issueDate: draft.issueDate,
      expiryDate: draft.expiryDate,
      ...(draft.beneficiary.trim() === '' ? {} : { beneficiary: draft.beneficiary.trim() }),
      ...(amount === undefined ? {} : { amount, currency: draft.currency.trim().toUpperCase() }),
      ...(draft.notes.trim() === '' ? {} : { notes: draft.notes.trim() }),
    };
    action.mutate(
      () =>
        parent === 'tenders'
          ? request(() => api.POST('/api/v1/tenders/{id}/guarantees', { params: { path: { id } }, body }))
          : request(() => api.POST('/api/v1/contracts/{id}/guarantees', { params: { path: { id } }, body })),
      { onSuccess: onDone },
    );
  };
  const text = (
    key: keyof typeof draft,
    label: string,
    props: { optional?: boolean; type?: string; maxLength?: number } = {},
  ) => (
    <Field label={label} errorCode={errors.get(key)} optional={props.optional ?? false}>
      {(control) => (
        <Input
          {...control}
          type={props.type ?? 'text'}
          required={props.optional !== true}
          maxLength={props.maxLength}
          value={draft[key]}
          onChange={(event) => {
            setDraft({ ...draft, [key]: event.target.value });
          }}
        />
      )}
    </Field>
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <SelectField
        label={t('fields.guaranteeType')}
        value={type}
        options={GUARANTEE_TYPES.map((value) => [value, t(`guaranteeTypes.${value}`)] as const)}
        onChange={setType}
        errorCode={errors.get('type')}
      />
      {text('referenceNumber', t('fields.referenceNumber'), { maxLength: 120 })}
      {text('issuer', t('fields.issuer'), { maxLength: 300 })}
      {text('beneficiary', t('fields.beneficiary'), { optional: true, maxLength: 300 })}
      <div className="grid gap-4 sm:grid-cols-2">
        {text('amount', t('fields.amount'), { optional: true, maxLength: 20 })}
        {text('currency', t('fields.currency'), { maxLength: 3 })}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {text('issueDate', t('fields.issueDate'), { type: 'date' })}
        {text('expiryDate', t('fields.expiryDate'), { type: 'date' })}
      </div>
      <Field label={t('fields.notes')} errorCode={errors.get('notes')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={2000}
            value={draft.notes}
            onChange={(event) => {
              setDraft({ ...draft, notes: event.target.value });
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        disabled={
          action.isPending ||
          draft.referenceNumber.trim() === '' ||
          draft.issuer.trim() === '' ||
          draft.issueDate === '' ||
          draft.expiryDate === '' ||
          (draft.amount.trim() !== '' && amount === undefined)
        }
      >
        {action.isPending ? t('saving') : t('guarantees.add')}
      </Button>
    </form>
  );
}

/** Small confirmation shown after a successful action. */
export function Done({ message }: { readonly message: string | null }) {
  return message === null ? null : <StatusMessage>{message}</StatusMessage>;
}

export function DetailCard({ children }: { readonly children: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">{children}</CardContent>
    </Card>
  );
}
