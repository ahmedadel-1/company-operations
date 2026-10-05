'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Input, Textarea } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import {
  AMENDMENT_TYPES,
  CONTRACT_TYPES,
  OBLIGATION_CATEGORIES,
  PRIORITIES,
  RECURRENCES,
  RENEWAL_ACTIONS,
  RENEWAL_TYPES,
  newIdempotencyKey,
  useAmendments,
  useCommercialAction,
  useMilestones,
  useObligations,
  useRenewalActions,
} from '../lib/commercial';
import type {
  Amendment,
  AmendmentType,
  CommercialPriority,
  Contract,
  ContractStatus,
  ContractType,
  Milestone,
  Obligation,
  ObligationCategory,
  Occurrence,
  Recurrence,
  RenewalActionType,
  RenewalType,
} from '../lib/commercial';
import { useDateFormat } from '../lib/format';
import { useProjects } from '../lib/projects';
import { useCan } from '../lib/session';
import {
  ActionDialog,
  COMMERCIAL_FILE_MAX_BYTES,
  COMMERCIAL_FILE_TYPES,
  DetailCard,
  DueDate,
  Facts,
  MilestoneStatusBadge,
  MoneyText,
  ObligationStatusBadge,
  Section,
  SelectField,
  useCommercialPerson,
} from './commercial';
import { EmployeePicker } from './employee-picker';
import type { PickedEmployee } from './employee-picker';
import { Field, FormError, StatusMessage, fieldErrorsOf } from './form';
import { Attachments } from './report-attachments';
import { EmptyState, ErrorState, ListSkeleton } from './states';

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

const SIGNED_AMOUNT = /^-?\d{1,15}(\.\d{1,4})?$/;

// ---- Overview ----

export function ContractOverview({ contract }: { readonly contract: Contract }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { date } = useDateFormat();
  const d = (value: string | null) => (value === null ? t('none') : date(value));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
        <ContractActions contract={contract} />
        {contract.healthReasons.length === 0 ? null : (
          <DetailCard>
            <h2 className="font-semibold">{t('health.reasons')}</h2>
            <ul className="flex flex-col gap-1 text-sm" data-testid="health-reasons">
              {contract.healthReasons.map((reason) => (
                <li key={reason}>{t(`healthReasons.${reason}`)}</li>
              ))}
            </ul>
          </DetailCard>
        )}
        <DetailCard>
          <Facts
            items={[
              [t('fields.contractType'), t(`contractTypes.${contract.contractType}`)],
              [t('fields.customer'), contract.customer?.name ?? contract.counterpartyName ?? t('noCustomer')],
              [
                t('fields.project'),
                contract.project === null ? t('none') : `${contract.project.code} · ${contract.project.name}`,
              ],
              [
                t('fields.sourceTender'),
                contract.sourceTender === null ? (
                  t('none')
                ) : (
                  <Link
                    key="tender"
                    href={`/tenders/${contract.sourceTender.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {contract.sourceTender.key} · {contract.sourceTender.title}
                  </Link>
                ),
              ],
              contract.internalReference === null ? null : [t('fields.internalReference'), contract.internalReference],
              [t('fields.owner'), person(contract.owner)],
              contract.access.canViewFinancial
                ? [t('fields.originalValue'), <MoneyText key="original" money={contract.originalValue} />]
                : null,
              contract.access.canViewFinancial
                ? [t('fields.currentValue'), <MoneyText key="current" money={contract.currentValue} />]
                : null,
              [t('fields.signedDate'), d(contract.signedDate)],
              [t('fields.effectiveDate'), d(contract.effectiveDate)],
              [t('fields.startDate'), d(contract.startDate)],
              [t('fields.originalExpiry'), d(contract.originalExpiryDate)],
              [t('fields.currentExpiry'), d(contract.currentExpiryDate)],
              [t('fields.renewalType'), t(`renewalTypes.${contract.renewalType}`)],
              contract.noticePeriodDays === null
                ? null
                : [t('fields.noticePeriod'), t('daysCount', { days: contract.noticePeriodDays })],
              contract.renewalNoticeDeadline === null
                ? null
                : [t('fields.noticeDeadline'), d(contract.renewalNoticeDeadline)],
              contract.renewalDecisionDate === null
                ? null
                : [t('fields.renewalDecisionDate'), d(contract.renewalDecisionDate)],
              contract.warrantyEndDate === null ? null : [t('fields.warrantyEnd'), d(contract.warrantyEndDate)],
              contract.supportEndDate === null ? null : [t('fields.supportEnd'), d(contract.supportEndDate)],
              contract.statusReason === null ? null : [t('fields.reason'), contract.statusReason],
            ]}
          />
          {contract.description === null ? null : <p className="text-sm whitespace-pre-wrap">{contract.description}</p>}
        </DetailCard>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <DetailCard>
          <h2 className="font-semibold">{t('contracts.summary')}</h2>
          <Facts
            items={[
              [t('counts.overdueObligations'), String(contract.counts.overdueObligations)],
              [t('counts.upcomingObligations'), String(contract.counts.upcomingObligations)],
              [t('counts.overdueMilestones'), String(contract.counts.overdueMilestones)],
              [t('counts.activeGuarantees'), String(contract.counts.activeGuarantees)],
              [t('counts.expiringGuarantees'), String(contract.counts.expiringGuarantees)],
              [t('counts.pendingAmendments'), String(contract.counts.pendingAmendments)],
            ]}
          />
        </DetailCard>
      </div>
    </div>
  );
}

function ContractActions({ contract }: { readonly contract: Contract }) {
  const t = useTranslations('commercial');
  const [done, setDone] = useState<string | null>(null);
  const access = contract.access;
  if (access.transitions.length === 0 && !access.canEdit) {
    return null;
  }
  return (
    <section aria-label={t('actions')} className="flex flex-col gap-2" data-testid="contract-actions">
      <div className="flex flex-wrap gap-2">
        {access.transitions.map((to) => (
          <ActionDialog
            key={to}
            label={t(`contractTransitions.${to}`)}
            title={t(`contractTransitions.${to}`)}
            variant={to === 'ACTIVE' ? 'default' : 'outline'}
            testId={`transition-${to}`}
          >
            {(close) => (
              <ContractTransitionForm
                contract={contract}
                to={to}
                onDone={() => {
                  close();
                  setDone(t('statusChanged'));
                }}
              />
            )}
          </ActionDialog>
        ))}
        {access.canEdit ? (
          <ActionDialog label={t('edit')} title={t('contracts.edit')} testId="edit-contract">
            {(close) => (
              <EditContractForm
                contract={contract}
                onDone={() => {
                  close();
                  setDone(t('saved'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
      </div>
      {done === null ? null : <StatusMessage>{done}</StatusMessage>}
    </section>
  );
}

function ContractTransitionForm({
  contract,
  to,
  onDone,
}: {
  readonly contract: Contract;
  readonly to: ContractStatus;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [reason, setReason] = useState('');
  const needsReason = to === 'SUSPENDED' || to === 'TERMINATED';
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = optional(reason);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/contracts/{id}/transition', {
            params: { path: { id: contract.id } },
            body: { version: contract.version, to, ...(text === undefined ? {} : { reason: text }) },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      {to === 'ACTIVE' && contract.status === 'AWAITING_SIGNATURE' ? (
        <p className="text-sm text-muted-foreground">{t('contracts.activateHint')}</p>
      ) : null}
      <Field label={t('fields.reason')} optional={!needsReason}>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={1000}
            required={needsReason}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={action.isPending || (needsReason && reason.trim() === '')}>
        {action.isPending ? t('saving') : t(`contractTransitions.${to}`)}
      </Button>
    </form>
  );
}

function EditContractForm({ contract, onDone }: { readonly contract: Contract; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const can = useCan();
  const projects = useProjects({}, can('project.view'));
  const action = useCommercialAction();
  const baseline = contract.status === 'DRAFT';
  const [projectId, setProjectId] = useState(contract.project?.id ?? '');
  const [contractType, setContractType] = useState<ContractType | ''>(contract.contractType);
  const [renewalType, setRenewalType] = useState<RenewalType | ''>(contract.renewalType);
  const [owner, setOwner] = useState<PickedEmployee | null>({
    id: contract.owner.memberId,
    fullName: contract.owner.name,
  });
  const [draft, setDraft] = useState({
    title: contract.title,
    description: contract.description ?? '',
    internalReference: contract.internalReference ?? '',
    signedDate: contract.signedDate ?? '',
    effectiveDate: contract.effectiveDate ?? '',
    startDate: contract.startDate ?? '',
    expiryDate: contract.originalExpiryDate ?? '',
    noticePeriodDays: contract.noticePeriodDays === null ? '' : String(contract.noticePeriodDays),
    renewalDecisionDate: contract.renewalDecisionDate ?? '',
    originalValue: contract.originalValue?.amount ?? '',
  });
  const errors = fieldErrorsOf(action.error);
  const notice = draft.noticePeriodDays.trim() === '' ? null : Number.parseInt(draft.noticePeriodDays, 10);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = {
      version: contract.version,
      title: draft.title.trim(),
      description: optional(draft.description) ?? null,
      internalReference: optional(draft.internalReference) ?? null,
      signedDate: draft.signedDate === '' ? null : draft.signedDate,
      effectiveDate: draft.effectiveDate === '' ? null : draft.effectiveDate,
      startDate: draft.startDate === '' ? null : draft.startDate,
      noticePeriodDays: notice !== null && Number.isFinite(notice) ? notice : null,
      renewalDecisionDate: draft.renewalDecisionDate === '' ? null : draft.renewalDecisionDate,
      ...(contractType === '' ? {} : { contractType }),
      ...(renewalType === '' ? {} : { renewalType }),
      ...(owner === null || owner.id === contract.owner.memberId ? {} : { ownerMemberId: owner.id }),
      ...(projectId === (contract.project?.id ?? '') ? {} : { projectId: projectId === '' ? null : projectId }),
      ...(baseline
        ? {
            expiryDate: draft.expiryDate === '' ? null : draft.expiryDate,
            ...(contract.access.canViewFinancial && /^\d{1,15}(\.\d{1,4})?$/.test(draft.originalValue.trim())
              ? { originalValue: draft.originalValue.trim() }
              : {}),
          }
        : {}),
    };
    action.mutate(
      () => request(() => api.PATCH('/api/v1/contracts/{id}', { params: { path: { id: contract.id } }, body })),
      {
        onSuccess: onDone,
      },
    );
  };
  const date = (key: keyof typeof draft, label: string) => (
    <Field label={label} optional errorCode={errors.get(key)}>
      {(control) => (
        <Input
          {...control}
          type="date"
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
      <Field label={t('fields.title')} errorCode={errors.get('title')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={300}
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label={t('fields.contractType')}
          value={contractType}
          options={CONTRACT_TYPES.map((value) => [value, t(`contractTypes.${value}`)] as const)}
          onChange={setContractType}
        />
        <SelectField
          label={t('fields.renewalType')}
          value={renewalType}
          options={RENEWAL_TYPES.map((value) => [value, t(`renewalTypes.${value}`)] as const)}
          onChange={setRenewalType}
        />
      </div>
      {projects.isSuccess ? (
        <SelectField
          label={t('fields.project')}
          value={projectId}
          options={[
            ...(contract.project === null ||
            projects.data.pages.some((page) => page.data.some((project) => project.id === contract.project?.id))
              ? []
              : [[contract.project.id, `${contract.project.code} · ${contract.project.name}`] as const]),
            ...projects.data.pages
              .flatMap((page) => page.data)
              .map((project) => [project.id, `${project.code} · ${project.name}`] as const),
          ]}
          onChange={setProjectId}
          errorCode={errors.get('projectId')}
          optional
          allowEmpty
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {date('signedDate', t('fields.signedDate'))}
        {date('effectiveDate', t('fields.effectiveDate'))}
        {date('startDate', t('fields.startDate'))}
        {baseline ? date('expiryDate', t('fields.expiryDate')) : null}
        {date('renewalDecisionDate', t('fields.renewalDecisionDate'))}
        <Field label={t('fields.noticePeriod')} optional errorCode={errors.get('noticePeriodDays')}>
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              max={3650}
              value={draft.noticePeriodDays}
              onChange={(event) => {
                setDraft({ ...draft, noticePeriodDays: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      {baseline && contract.access.canViewFinancial ? (
        <Field label={t('fields.originalValue')} errorCode={errors.get('originalValue')} hint={t('money.hint')}>
          {(control) => (
            <Input
              {...control}
              value={draft.originalValue}
              onChange={(event) => {
                setDraft({ ...draft, originalValue: event.target.value });
              }}
            />
          )}
        </Field>
      ) : baseline ? null : (
        <p className="text-xs text-muted-foreground">{t('contracts.baselineLocked')}</p>
      )}
      <Field label={t('fields.internalReference')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={100}
            value={draft.internalReference}
            onChange={(event) => {
              setDraft({ ...draft, internalReference: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.description')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={5000}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
          />
        )}
      </Field>
      <EmployeePicker label={t('fields.owner')} value={owner} onChange={setOwner} identity="member" />
      <Button type="submit" disabled={action.isPending || draft.title.trim() === '' || owner === null}>
        {action.isPending ? t('saving') : t('save')}
      </Button>
    </form>
  );
}

// ---- Obligations ----

export function ObligationsTab({ contract }: { readonly contract: Contract }) {
  const t = useTranslations('commercial');
  const obligations = useObligations(contract.id);
  return (
    <Section
      title={t('obligations.title')}
      actions={
        contract.access.canManageObligations ? (
          <ActionDialog label={t('obligations.add')} title={t('obligations.add')} testId="add-obligation">
            {(close) => <ObligationForm contract={contract} onDone={close} />}
          </ActionDialog>
        ) : undefined
      }
    >
      {obligations.isPending ? (
        <ListSkeleton rows={3} />
      ) : obligations.isError ? (
        <ErrorState
          error={obligations.error}
          onRetry={() => {
            void obligations.refetch();
          }}
        />
      ) : obligations.data.length === 0 ? (
        <EmptyState message={t('obligations.empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="obligations">
          {obligations.data.map((obligation) => (
            <ObligationItem key={obligation.id} contract={contract} obligation={obligation} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ObligationItem({ contract, obligation }: { readonly contract: Contract; readonly obligation: Obligation }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const action = useCommercialAction();
  const open = obligation.occurrences.filter(
    (occurrence) =>
      occurrence.status !== 'COMPLETED' && occurrence.status !== 'WAIVED' && occurrence.status !== 'CANCELLED',
  );
  const closed = obligation.occurrences.filter((occurrence) => !open.includes(occurrence));
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4" data-testid="obligation">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium break-words">{obligation.title}</span>
          <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{t(`obligationCategories.${obligation.category}`)}</span>
            <span>·</span>
            <span>{t(`recurrences.${obligation.recurrence}`)}</span>
            {obligation.criticality === 'CRITICAL' ? (
              <>
                <span>·</span>
                <span className="font-medium text-destructive">{t('obligations.critical')}</span>
              </>
            ) : null}
            {obligation.evidenceRequired ? (
              <>
                <span>·</span>
                <span>{t('obligations.evidenceRequired')}</span>
              </>
            ) : null}
          </span>
        </div>
        {obligation.cancelledAt === null ? null : <Badge>{t('obligationStatuses.CANCELLED')}</Badge>}
      </div>
      <Facts
        items={[
          [t('fields.owner'), person(obligation.owner)],
          [t('fields.reviewer'), person(obligation.reviewer)],
          [t('fields.priority'), t(`priorities.${obligation.priority}`)],
          obligation.recurrenceUntil === null
            ? null
            : [t('fields.recurrenceUntil'), <DueDate key="until" date={obligation.recurrenceUntil} />],
        ]}
      />
      {open.length === 0 ? null : (
        <ul className="flex flex-col gap-2" data-testid="occurrences">
          {open.map((occurrence) => (
            <OccurrenceItem key={occurrence.id} contractId={contract.id} occurrence={occurrence} />
          ))}
        </ul>
      )}
      {closed.length === 0 ? null : (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t('obligations.history', { count: closed.length })}
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {closed.map((occurrence) => (
              <li key={occurrence.id} className="flex flex-wrap items-center gap-2">
                <DueDate date={occurrence.dueDate} />
                <ObligationStatusBadge status={occurrence.status} />
                {occurrence.completionNote === null ? null : (
                  <span className="text-muted-foreground">{occurrence.completionNote}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {contract.access.canManageObligations && obligation.cancelledAt === null ? (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => {
              if (window.confirm(t('obligations.confirmCancel', { title: obligation.title }))) {
                action.mutate(() =>
                  request(() =>
                    api.POST('/api/v1/contracts/{id}/obligations/{obligationId}/cancel', {
                      params: { path: { id: contract.id, obligationId: obligation.id } },
                      body: { version: obligation.version },
                    }),
                  ),
                );
              }
            }}
          >
            {t('obligations.cancel')}
          </Button>
        </div>
      ) : null}
      <FormError error={action.error} />
    </li>
  );
}

function OccurrenceItem({ contractId, occurrence }: { readonly contractId: string; readonly occurrence: Occurrence }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [note, setNote] = useState('');
  const setStatus = (status: 'IN_PROGRESS' | 'COMPLETED' | 'WAIVED') => {
    const text = optional(note);
    action.mutate(() =>
      request(() =>
        api.POST('/api/v1/contracts/{id}/occurrences/{occurrenceId}/status', {
          params: { path: { id: contractId, occurrenceId: occurrence.id } },
          body: {
            version: occurrence.version,
            status,
            ...(text === undefined ? {} : status === 'WAIVED' ? { waivedReason: text } : { note: text }),
          },
        }),
      ),
    );
  };
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-dashed p-3"
      data-testid="occurrence"
      data-status={occurrence.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          {t('fields.dueDate')}: <DueDate date={occurrence.dueDate} overdue={occurrence.status === 'OVERDUE'} />
        </span>
        <ObligationStatusBadge status={occurrence.status} />
      </div>
      {occurrence.canWork ? (
        <>
          <label className="sr-only" htmlFor={`occ-${occurrence.id}`}>
            {t('fields.note')}
          </label>
          <Input
            id={`occ-${occurrence.id}`}
            placeholder={t('obligations.notePlaceholder')}
            maxLength={2000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <div className="flex flex-wrap gap-2">
            {occurrence.status !== 'IN_PROGRESS' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={action.isPending}
                onClick={() => {
                  setStatus('IN_PROGRESS');
                }}
              >
                {t('obligations.start')}
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={action.isPending || (occurrence.evidenceRequired && occurrence.evidenceAttachments === 0)}
              data-testid="complete-occurrence"
              onClick={() => {
                setStatus('COMPLETED');
              }}
            >
              {t('obligations.complete')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending || note.trim() === ''}
              onClick={() => {
                setStatus('WAIVED');
              }}
            >
              {t('obligations.waive')}
            </Button>
          </div>
          {occurrence.evidenceRequired && occurrence.evidenceAttachments === 0 ? (
            <p className="text-xs text-muted-foreground">{t('obligations.evidenceFirst')}</p>
          ) : null}
        </>
      ) : null}
      <FormError error={action.error} />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t('obligations.evidence', { count: occurrence.evidenceAttachments })}
        </summary>
        <div className="mt-2">
          <Attachments
            ownerType="OBLIGATION_OCCURRENCE"
            ownerId={occurrence.id}
            allowedTypes={COMMERCIAL_FILE_TYPES}
            maxBytes={COMMERCIAL_FILE_MAX_BYTES}
            hint={t('files.hint')}
            badType={t('files.badType')}
            tooLarge={t('files.tooLarge')}
            title={t('obligations.evidenceTitle')}
            testId="occurrence-evidence"
            canUpload={occurrence.canWork}
            canDelete={false}
          />
        </div>
      </details>
    </li>
  );
}

function ObligationForm({ contract, onDone }: { readonly contract: Contract; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [category, setCategory] = useState<ObligationCategory | ''>('REPORTING');
  const [recurrence, setRecurrence] = useState<Recurrence | ''>('NONE');
  const [priority, setPriority] = useState<CommercialPriority | ''>('MEDIUM');
  const [critical, setCritical] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const [owner, setOwner] = useState<PickedEmployee | null>(null);
  const [draft, setDraft] = useState({ title: '', description: '', dueDate: '', recurrenceUntil: '' });
  const errors = fieldErrorsOf(action.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (category === '') return;
    const description = optional(draft.description);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/contracts/{id}/obligations', {
            params: { path: { id: contract.id } },
            body: {
              title: draft.title.trim(),
              category,
              dueDate: draft.dueDate,
              criticality: critical ? 'CRITICAL' : 'STANDARD',
              evidenceRequired: evidence,
              ...(recurrence === '' ? {} : { recurrence }),
              ...(priority === '' ? {} : { priority }),
              ...(owner === null ? {} : { ownerMemberId: owner.id }),
              ...(description === undefined ? {} : { description }),
              ...(draft.recurrenceUntil === '' || recurrence === 'NONE'
                ? {}
                : { recurrenceUntil: draft.recurrenceUntil }),
            },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="obligation-form">
      <FormError error={action.error} />
      <Field label={t('fields.title')} errorCode={errors.get('title')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={300}
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label={t('fields.category')}
          value={category}
          options={OBLIGATION_CATEGORIES.map((value) => [value, t(`obligationCategories.${value}`)] as const)}
          onChange={setCategory}
        />
        <SelectField
          label={t('fields.priority')}
          value={priority}
          options={PRIORITIES.map((value) => [value, t(`priorities.${value}`)] as const)}
          onChange={setPriority}
        />
        <Field label={t('fields.firstDueDate')} errorCode={errors.get('dueDate')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              required
              value={draft.dueDate}
              onChange={(event) => {
                setDraft({ ...draft, dueDate: event.target.value });
              }}
            />
          )}
        </Field>
        <SelectField
          label={t('fields.recurrence')}
          value={recurrence}
          options={RECURRENCES.map((value) => [value, t(`recurrences.${value}`)] as const)}
          onChange={setRecurrence}
        />
        {recurrence !== 'NONE' && recurrence !== '' ? (
          <Field label={t('fields.recurrenceUntil')} optional errorCode={errors.get('recurrenceUntil')}>
            {(control) => (
              <Input
                {...control}
                type="date"
                value={draft.recurrenceUntil}
                onChange={(event) => {
                  setDraft({ ...draft, recurrenceUntil: event.target.value });
                }}
              />
            )}
          </Field>
        ) : null}
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={critical}
          onChange={(event) => {
            setCritical(event.target.checked);
          }}
        />
        {t('obligations.critical')}
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={evidence}
          onChange={(event) => {
            setEvidence(event.target.checked);
          }}
        />
        {t('obligations.evidenceRequired')}
      </label>
      <Field label={t('fields.description')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={5000}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
          />
        )}
      </Field>
      <EmployeePicker label={t('fields.owner')} value={owner} onChange={setOwner} identity="member" allowNone />
      <Button type="submit" disabled={action.isPending || draft.title.trim() === '' || draft.dueDate === ''}>
        {action.isPending ? t('saving') : t('obligations.add')}
      </Button>
    </form>
  );
}

// ---- Milestones ----

export function MilestonesTab({ contract }: { readonly contract: Contract }) {
  const t = useTranslations('commercial');
  const milestones = useMilestones(contract.id);
  return (
    <Section
      title={t('milestones.title')}
      actions={
        contract.access.canManageMilestones ? (
          <ActionDialog label={t('milestones.add')} title={t('milestones.add')} testId="add-milestone">
            {(close) => <MilestoneForm contract={contract} onDone={close} />}
          </ActionDialog>
        ) : undefined
      }
    >
      {milestones.isPending ? (
        <ListSkeleton rows={3} />
      ) : milestones.isError ? (
        <ErrorState
          error={milestones.error}
          onRetry={() => {
            void milestones.refetch();
          }}
        />
      ) : milestones.data.length === 0 ? (
        <EmptyState message={t('milestones.empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="milestones">
          {milestones.data.map((milestone) => (
            <MilestoneItem key={milestone.id} contract={contract} milestone={milestone} />
          ))}
        </ul>
      )}
    </Section>
  );
}

type MilestoneTarget = 'IN_PROGRESS' | 'SUBMITTED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED';

function milestoneTargets(contract: Contract, milestone: Milestone): MilestoneTarget[] {
  const status = milestone.status;
  if (status === 'COMPLETED' || status === 'CANCELLED') return [];
  const targets: MilestoneTarget[] = [];
  if (milestone.canWork) {
    if (status === 'NOT_STARTED' || status === 'OVERDUE') targets.push('IN_PROGRESS');
    if (milestone.approvalRequired && status !== 'SUBMITTED' && status !== 'APPROVED') targets.push('SUBMITTED');
    if (!milestone.approvalRequired || status === 'APPROVED') targets.push('COMPLETED');
  }
  if (contract.access.canApprove && milestone.approvalRequired && status === 'SUBMITTED') targets.push('APPROVED');
  if (contract.access.canManageMilestones) targets.push('CANCELLED');
  return targets;
}

function MilestoneItem({ contract, milestone }: { readonly contract: Contract; readonly milestone: Milestone }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const action = useCommercialAction();
  const targets = milestoneTargets(contract, milestone);
  const setStatus = (status: MilestoneTarget) => {
    action.mutate(() =>
      request(() =>
        api.POST('/api/v1/contracts/{id}/milestones/{milestoneId}/status', {
          params: { path: { id: contract.id, milestoneId: milestone.id } },
          body: { version: milestone.version, status },
        }),
      ),
    );
  };
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4" data-testid="milestone" data-status={milestone.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="font-medium break-words">{milestone.title}</span>
        <MilestoneStatusBadge status={milestone.status} />
      </div>
      <Facts
        items={[
          [
            t('fields.dueDate'),
            <DueDate key="due" date={milestone.dueDate} overdue={milestone.status === 'OVERDUE'} />,
          ],
          [t('fields.owner'), person(milestone.owner)],
          milestone.project === null
            ? null
            : [t('fields.project'), `${milestone.project.code} · ${milestone.project.name}`],
          [t('fields.approvalRequired'), milestone.approvalRequired ? t('yes') : t('no')],
          milestone.approvedBy === null ? null : [t('fields.approvedBy'), person(milestone.approvedBy)],
        ]}
      />
      {targets.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {targets.map((to) => (
            <Button
              key={to}
              size="sm"
              variant={to === 'CANCELLED' ? 'ghost' : to === 'COMPLETED' || to === 'APPROVED' ? 'default' : 'outline'}
              disabled={action.isPending}
              data-testid={`milestone-${to}`}
              onClick={() => {
                if (to !== 'CANCELLED' || window.confirm(t('milestones.confirmCancel', { title: milestone.title }))) {
                  setStatus(to);
                }
              }}
            >
              {t(`milestoneActions.${to}`)}
            </Button>
          ))}
        </div>
      )}
      <FormError error={action.error} />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t('milestones.evidence', { count: milestone.evidenceAttachments })}
        </summary>
        <div className="mt-2">
          <Attachments
            ownerType="CONTRACT_MILESTONE"
            ownerId={milestone.id}
            allowedTypes={COMMERCIAL_FILE_TYPES}
            maxBytes={COMMERCIAL_FILE_MAX_BYTES}
            hint={t('files.hint')}
            badType={t('files.badType')}
            tooLarge={t('files.tooLarge')}
            title={t('milestones.evidenceTitle')}
            testId="milestone-evidence"
            canUpload={milestone.canWork}
            canDelete={false}
          />
        </div>
      </details>
    </li>
  );
}

function MilestoneForm({ contract, onDone }: { readonly contract: Contract; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [owner, setOwner] = useState<PickedEmployee | null>(null);
  const [approval, setApproval] = useState(true);
  const [draft, setDraft] = useState({ title: '', description: '', dueDate: '' });
  const errors = fieldErrorsOf(action.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const description = optional(draft.description);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/contracts/{id}/milestones', {
            params: { path: { id: contract.id } },
            body: {
              title: draft.title.trim(),
              dueDate: draft.dueDate,
              approvalRequired: approval,
              ...(contract.project === null ? {} : { projectId: contract.project.id }),
              ...(owner === null ? {} : { ownerMemberId: owner.id }),
              ...(description === undefined ? {} : { description }),
            },
          }),
        ),
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
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.dueDate')} errorCode={errors.get('dueDate')}>
        {(control) => (
          <Input
            {...control}
            type="date"
            required
            value={draft.dueDate}
            onChange={(event) => {
              setDraft({ ...draft, dueDate: event.target.value });
            }}
          />
        )}
      </Field>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={approval}
          onChange={(event) => {
            setApproval(event.target.checked);
          }}
        />
        {t('fields.approvalRequired')}
      </label>
      <Field label={t('fields.description')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={5000}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
          />
        )}
      </Field>
      <EmployeePicker label={t('fields.owner')} value={owner} onChange={setOwner} identity="member" allowNone />
      <Button type="submit" disabled={action.isPending || draft.title.trim() === '' || draft.dueDate === ''}>
        {action.isPending ? t('saving') : t('milestones.add')}
      </Button>
    </form>
  );
}

// ---- Amendments ----

export function AmendmentsTab({ contract }: { readonly contract: Contract }) {
  const t = useTranslations('commercial');
  const amendments = useAmendments(contract.id);
  return (
    <Section
      title={t('amendments.title')}
      actions={
        contract.access.canManageAmendments ? (
          <ActionDialog label={t('amendments.add')} title={t('amendments.add')} testId="add-amendment">
            {(close) => <AmendmentForm contract={contract} onDone={close} />}
          </ActionDialog>
        ) : undefined
      }
    >
      {amendments.isPending ? (
        <ListSkeleton rows={3} />
      ) : amendments.isError ? (
        <ErrorState
          error={amendments.error}
          onRetry={() => {
            void amendments.refetch();
          }}
        />
      ) : amendments.data.length === 0 ? (
        <EmptyState message={t('amendments.empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="amendments">
          {amendments.data.map((amendment) => (
            <AmendmentItem key={amendment.id} contract={contract} amendment={amendment} />
          ))}
        </ul>
      )}
    </Section>
  );
}

type AmendmentAction = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'ACTIVATE' | 'CANCEL';

function AmendmentItem({ contract, amendment }: { readonly contract: Contract; readonly amendment: Amendment }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { date } = useDateFormat();
  const action = useCommercialAction();
  const [reason, setReason] = useState('');
  const run = (kind: AmendmentAction) => {
    const text = optional(reason);
    action.mutate(() =>
      request(() =>
        api.POST('/api/v1/contracts/{id}/amendments/{amendmentId}/actions', {
          params: { path: { id: contract.id, amendmentId: amendment.id } },
          body: { version: amendment.version, action: kind, ...(text === undefined ? {} : { reason: text }) },
        }),
      ),
    );
  };
  const available: AmendmentAction[] = [
    ...(amendment.access.canSubmit ? (['SUBMIT'] as const) : []),
    ...(amendment.access.canApprove ? (['APPROVE', 'REJECT'] as const) : []),
    ...(amendment.access.canActivate ? (['ACTIVATE'] as const) : []),
    ...(amendment.access.canCancel ? (['CANCEL'] as const) : []),
  ];
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4" data-testid="amendment" data-status={amendment.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium break-words">
            {amendment.key} · {amendment.title}
          </span>
          <span className="text-xs text-muted-foreground">{t(`amendmentTypes.${amendment.type}`)}</span>
        </div>
        <Badge
          tone={
            amendment.status === 'EFFECTIVE'
              ? 'success'
              : amendment.status === 'REJECTED'
                ? 'danger'
                : amendment.status === 'UNDER_REVIEW'
                  ? 'warning'
                  : 'neutral'
          }
          data-testid="amendment-status"
        >
          {t(`amendmentStatuses.${amendment.status}`)}
        </Badge>
      </div>
      <Facts
        items={[
          [t('fields.effectiveDate'), date(amendment.effectiveDate)],
          amendment.hasValueChange
            ? [t('fields.valueDelta'), <MoneyText key="delta" money={amendment.valueDelta} />]
            : null,
          amendment.newExpiryDate === null ? null : [t('fields.newExpiry'), date(amendment.newExpiryDate)],
          [t('fields.createdBy'), person(amendment.createdBy)],
          amendment.approvedBy === null ? null : [t('fields.approvedBy'), person(amendment.approvedBy)],
          amendment.rejectionReason === null ? null : [t('fields.reason'), amendment.rejectionReason],
        ]}
      />
      {amendment.scopeChangeSummary === null ? null : (
        <p className="text-sm whitespace-pre-wrap">{amendment.scopeChangeSummary}</p>
      )}
      {available.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          {available.includes('REJECT') || available.includes('CANCEL') ? (
            <>
              <label className="sr-only" htmlFor={`reason-${amendment.id}`}>
                {t('fields.reason')}
              </label>
              <Input
                id={`reason-${amendment.id}`}
                placeholder={t('amendments.reasonPlaceholder')}
                maxLength={1000}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {available.map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant={
                  kind === 'APPROVE' || kind === 'ACTIVATE' || kind === 'SUBMIT'
                    ? 'default'
                    : kind === 'CANCEL'
                      ? 'ghost'
                      : 'outline'
                }
                disabled={action.isPending || (kind === 'REJECT' && reason.trim() === '')}
                data-testid={`amendment-${kind}`}
                onClick={() => {
                  run(kind);
                }}
              >
                {t(`amendmentActions.${kind}`)}
              </Button>
            ))}
          </div>
        </div>
      )}
      <FormError error={action.error} />
    </li>
  );
}

function AmendmentForm({ contract, onDone }: { readonly contract: Contract; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [type, setType] = useState<AmendmentType | ''>('TIME_EXTENSION');
  const [draft, setDraft] = useState({
    title: '',
    description: '',
    effectiveDate: '',
    valueDelta: '',
    newExpiryDate: '',
    scope: '',
  });
  const errors = fieldErrorsOf(action.error);
  const delta = draft.valueDelta.trim();
  const deltaValid = delta === '' || SIGNED_AMOUNT.test(delta);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (type === '' || !deltaValid) return;
    const description = optional(draft.description);
    const scope = optional(draft.scope);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/contracts/{id}/amendments', {
            params: { path: { id: contract.id } },
            body: {
              type,
              title: draft.title.trim(),
              effectiveDate: draft.effectiveDate,
              ...(description === undefined ? {} : { description }),
              ...(delta === '' ? {} : { valueDelta: delta }),
              ...(draft.newExpiryDate === '' ? {} : { newExpiryDate: draft.newExpiryDate }),
              ...(scope === undefined ? {} : { scopeChangeSummary: scope }),
            },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="amendment-form">
      <FormError error={action.error} />
      <SelectField
        label={t('fields.amendmentType')}
        value={type}
        options={AMENDMENT_TYPES.map((value) => [value, t(`amendmentTypes.${value}`)] as const)}
        onChange={setType}
      />
      <Field label={t('fields.title')} errorCode={errors.get('title')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={300}
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('fields.effectiveDate')} errorCode={errors.get('effectiveDate')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              required
              value={draft.effectiveDate}
              onChange={(event) => {
                setDraft({ ...draft, effectiveDate: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label={t('fields.newExpiry')} optional errorCode={errors.get('newExpiryDate')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={draft.newExpiryDate}
              onChange={(event) => {
                setDraft({ ...draft, newExpiryDate: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      {contract.access.canViewFinancial ? (
        <Field
          label={t('fields.valueDelta')}
          optional
          hint={t('amendments.deltaHint', { currency: contract.currentValue?.currency ?? '' })}
          errorCode={deltaValid ? errors.get('valueDelta') : 'invalid'}
        >
          {(control) => (
            <Input
              {...control}
              value={draft.valueDelta}
              onChange={(event) => {
                setDraft({ ...draft, valueDelta: event.target.value });
              }}
            />
          )}
        </Field>
      ) : null}
      <Field label={t('fields.scopeChange')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={5000}
            value={draft.scope}
            onChange={(event) => {
              setDraft({ ...draft, scope: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.description')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={5000}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
          />
        )}
      </Field>
      <Button
        type="submit"
        disabled={action.isPending || draft.title.trim() === '' || draft.effectiveDate === '' || !deltaValid}
      >
        {action.isPending ? t('saving') : t('amendments.add')}
      </Button>
    </form>
  );
}

// ---- Renewal ----

export function RenewalTab({ contract }: { readonly contract: Contract }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime, date } = useDateFormat();
  const actions = useRenewalActions(contract.id);
  return (
    <div className="flex flex-col gap-6">
      <DetailCard>
        <Facts
          items={[
            [t('fields.renewalType'), t(`renewalTypes.${contract.renewalType}`)],
            [
              t('fields.currentExpiry'),
              contract.currentExpiryDate === null ? t('none') : date(contract.currentExpiryDate),
            ],
            [
              t('fields.noticeDeadline'),
              contract.renewalNoticeDeadline === null ? t('none') : date(contract.renewalNoticeDeadline),
            ],
            [
              t('fields.renewalDecisionDate'),
              contract.renewalDecisionDate === null ? t('none') : date(contract.renewalDecisionDate),
            ],
            contract.lastRenewalAction === null
              ? null
              : [
                  t('renewal.last'),
                  `${t(`renewalActions.${contract.lastRenewalAction.action}`)} · ${dateTime(contract.lastRenewalAction.createdAt)}`,
                ],
          ]}
        />
        {contract.access.canManageRenewal ? (
          <div>
            <ActionDialog
              label={t('renewal.record')}
              title={t('renewal.record')}
              variant="default"
              testId="record-renewal"
            >
              {(close) => <RenewalForm contract={contract} onDone={close} />}
            </ActionDialog>
          </div>
        ) : null}
      </DetailCard>
      <Section title={t('renewal.history')}>
        {actions.isPending ? (
          <ListSkeleton rows={2} />
        ) : actions.isError ? (
          <ErrorState error={actions.error} />
        ) : actions.data.length === 0 ? (
          <EmptyState message={t('renewal.empty')} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="renewal-actions">
            {actions.data.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
                <span className="font-medium">{t(`renewalActions.${entry.action}`)}</span>
                <span className="text-muted-foreground">
                  {person(entry.actor)} · {dateTime(entry.createdAt)}
                  {entry.newExpiryDate === null ? '' : ` · ${t('fields.newExpiry')}: ${date(entry.newExpiryDate)}`}
                </span>
                {entry.comment === null ? null : <span>{entry.comment}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function RenewalForm({ contract, onDone }: { readonly contract: Contract; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [key] = useState(newIdempotencyKey);
  const [kind, setKind] = useState<RenewalActionType | ''>('REVIEW_STARTED');
  const [comment, setComment] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const needsDate = kind === 'RENEWED' || kind === 'EXTENDED';
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (kind === '') return;
    const text = optional(comment);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/contracts/{id}/renewal-actions', {
            params: { path: { id: contract.id }, header: { 'Idempotency-Key': key } },
            body: {
              version: contract.version,
              action: kind,
              ...(text === undefined ? {} : { comment: text }),
              ...(needsDate && newExpiry !== '' ? { newExpiryDate: newExpiry } : {}),
            },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <SelectField
        label={t('fields.renewalAction')}
        value={kind}
        options={RENEWAL_ACTIONS.map((value) => [value, t(`renewalActions.${value}`)] as const)}
        onChange={setKind}
      />
      {needsDate ? (
        <Field label={t('fields.newExpiry')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              required
              value={newExpiry}
              onChange={(event) => {
                setNewExpiry(event.target.value);
              }}
            />
          )}
        </Field>
      ) : null}
      <Field label={t('fields.comments')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={2000}
            value={comment}
            onChange={(event) => {
              setComment(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={action.isPending || kind === '' || (needsDate && newExpiry === '')}>
        {action.isPending ? t('saving') : t('renewal.record')}
      </Button>
    </form>
  );
}
