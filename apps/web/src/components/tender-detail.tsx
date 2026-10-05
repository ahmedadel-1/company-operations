'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Input, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { api, request, requestEmpty } from '../lib/api';
import {
  BID_CRITERIA,
  CONTRACT_TYPES,
  LOSS_REASONS,
  NO_BID_REASONS,
  PRIORITIES,
  REQUIREMENT_CATEGORIES,
  REVIEW_GATES,
  SUBMISSION_METHODS,
  amountOrUndefined,
  localInputToIso,
  newIdempotencyKey,
  zonedInputToIso,
  useBidDecisions,
  useCommercialAction,
  useCorporateDocument,
  useCorporateDocuments,
  useParentDocuments,
  useTenderAddenda,
  useTenderClarifications,
  useTenderRequirements,
  useTenderReviews,
  useTenderSubmissions,
} from '../lib/commercial';
import type {
  BidDecisionRecord,
  CommercialPriority,
  ContractType,
  LossReason,
  NoBidReason,
  RequirementCategory,
  RequirementStatus,
  ReviewGateType,
  SubmissionMethod,
  Tender,
  TenderClarification,
  TenderRequirement,
  TenderReviewGate,
  TenderStatus,
} from '../lib/commercial';
import { useDateFormat } from '../lib/format';
import { useOrganization } from '../lib/queries';
import { useCan } from '../lib/session';
import {
  ActionDialog,
  COMMERCIAL_FILE_MAX_BYTES,
  COMMERCIAL_FILE_TYPES,
  DetailCard,
  DueDate,
  Facts,
  MoneyText,
  RequirementStatusBadge,
  Section,
  SelectField,
  useCommercialPerson,
} from './commercial';
import { EmployeePicker } from './employee-picker';
import type { PickedEmployee } from './employee-picker';
import { Field, FormError, StatusMessage, fieldErrorsOf } from './form';
import { Attachments } from './report-attachments';
import { EmptyState, ErrorState, ListSkeleton } from './states';

type Criteria = BidDecisionRecord['criteria'];
type CriterionValue = Criteria['technicalFit'];

function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `datetime-local` value for "now" in the browser's wall time. */
function nowLocalInput(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function todayInput(): string {
  return nowLocalInput().slice(0, 10);
}

// ---- Overview ----

export function TenderOverview({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime, date } = useDateFormat();
  const readiness = tender.readiness;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
        <TenderActions tender={tender} />
        <DetailCard>
          <Facts
            items={[
              [t('fields.tenderType'), t(`tenderTypes.${tender.tenderType}`)],
              [t('fields.priority'), t(`priorities.${tender.priority}`)],
              [t('fields.customer'), tender.customer?.name ?? tender.counterpartyName ?? t('noCustomer')],
              [
                t('fields.relatedProject'),
                tender.relatedProject === null
                  ? t('none')
                  : `${tender.relatedProject.code} · ${tender.relatedProject.name}`,
              ],
              [
                t('fields.deadline'),
                tender.submissionDeadlineAt === null
                  ? t('noDeadline')
                  : `${dateTime(tender.submissionDeadlineAt)}${
                      tender.submissionDeadlineTimeZone === null ? '' : ` (${tender.submissionDeadlineTimeZone})`
                    }`,
              ],
              tender.clarificationDeadlineAt === null
                ? null
                : [t('fields.clarificationDeadline'), dateTime(tender.clarificationDeadlineAt)],
              tender.internalReference === null ? null : [t('fields.internalReference'), tender.internalReference],
              tender.procurementMethod === null ? null : [t('fields.procurementMethod'), tender.procurementMethod],
              [t('fields.owner'), person(tender.owner)],
              [t('fields.technicalLead'), person(tender.technicalLead)],
              [t('fields.commercialLead'), person(tender.commercialLead)],
              tender.access.canViewFinancial
                ? [t('fields.estimatedValue'), <MoneyText key="value" money={tender.estimatedValue} />]
                : null,
              [t('fields.bidDecision'), t(`bidDecisions.${tender.bidDecision}`)],
            ]}
          />
          {tender.description === null ? null : <p className="text-sm whitespace-pre-wrap">{tender.description}</p>}
        </DetailCard>
        {tender.submission === null ? null : (
          <DetailCard>
            <h2 className="font-semibold">{t('submission.title')}</h2>
            <Facts
              items={[
                [t('fields.submissionMethod'), t(`submissionMethods.${tender.submission.method}`)],
                [t('fields.submittedAt'), dateTime(tender.submission.submittedAt)],
                tender.submission.reference === null ? null : [t('fields.reference'), tender.submission.reference],
                [t('fields.submittedBy'), person(tender.submission.submittedBy)],
              ]}
            />
          </DetailCard>
        )}
        {tender.award === null ? null : (
          <DetailCard>
            <h2 className="font-semibold">{t('award.title')}</h2>
            <Facts
              items={[
                [t('fields.awardDate'), date(tender.award.awardDate)],
                tender.access.canViewFinancial
                  ? [t('fields.awardValue'), <MoneyText key="award" money={tender.award.value} />]
                  : null,
                tender.award.reference === null ? null : [t('fields.reference'), tender.award.reference],
                tender.award.notes === null ? null : [t('fields.notes'), tender.award.notes],
              ]}
            />
          </DetailCard>
        )}
        {tender.loss === null ? null : (
          <DetailCard>
            <h2 className="font-semibold">{t('loss.title')}</h2>
            <Facts
              items={[
                [t('fields.lossReason'), t(`lossReasons.${tender.loss.reason}`)],
                tender.loss.winningCompany === null ? null : [t('fields.winningCompany'), tender.loss.winningCompany],
                tender.access.canViewFinancial
                  ? [t('fields.winningValue'), <MoneyText key="winning" money={tender.loss.winningValue} />]
                  : null,
                tender.loss.debriefNotes === null ? null : [t('fields.debriefNotes'), tender.loss.debriefNotes],
                tender.loss.lessonsLearned === null ? null : [t('fields.lessonsLearned'), tender.loss.lessonsLearned],
              ]}
            />
          </DetailCard>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <DetailCard>
          <h2 className="font-semibold">{t('fields.readiness')}</h2>
          <p className="text-3xl font-semibold" data-testid="readiness-percent">
            {readiness.percent === null
              ? t('readiness.noMandatory')
              : t('readiness.percent', { percent: readiness.percent })}
          </p>
          {readiness.percent === null ? null : (
            <progress
              className="h-2 w-full"
              max={100}
              value={readiness.percent}
              aria-label={t('readiness.percent', { percent: readiness.percent })}
            />
          )}
          <Facts
            items={[
              [
                t('readiness.mandatoryApproved'),
                `${String(readiness.mandatoryApproved)} / ${String(readiness.mandatoryApplicable)}`,
              ],
              [t('readiness.mandatoryMissing'), String(readiness.mandatoryMissing)],
              [t('readiness.blocked'), String(readiness.blocked)],
              [t('readiness.unassigned'), String(readiness.unassigned)],
              readiness.overdue === null ? null : [t('readiness.overdue'), String(readiness.overdue)],
              [t('readiness.total'), String(readiness.total)],
            ]}
          />
        </DetailCard>
        {tender.contracts.length === 0 ? null : (
          <DetailCard>
            <h2 className="font-semibold">{t('tenders.contracts')}</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {tender.contracts.map((contract) => (
                <li key={contract.id}>
                  <Link href={`/contracts/${contract.id}`} className="underline-offset-4 hover:underline">
                    {contract.key} · {contract.title}
                  </Link>
                </li>
              ))}
            </ul>
          </DetailCard>
        )}
      </div>
    </div>
  );
}

function TenderActions({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  const can = useCan();
  const router = useRouter();
  const [done, setDone] = useState<string | null>(null);
  const access = tender.access;
  const remove = useCommercialAction();
  const any =
    access.transitions.length > 0 ||
    access.canEdit ||
    access.canDelete ||
    access.canDecideBid ||
    access.canRequestReview ||
    access.canSubmit ||
    access.canRecordAward ||
    access.canRecordLoss ||
    access.canCreateContract;
  if (!any) {
    return null;
  }
  return (
    <section aria-label={t('actions')} className="flex flex-col gap-2" data-testid="tender-actions">
      <div className="flex flex-wrap gap-2">
        {access.canDecideBid ? (
          <ActionDialog label={t('bid.decide')} title={t('bid.decide')} variant="default" testId="bid-decision">
            {(close) => (
              <BidDecisionForm
                tender={tender}
                onDone={() => {
                  close();
                  setDone(t('bid.done'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
        {access.canRequestReview ? (
          <ActionDialog
            label={t('reviews.request')}
            title={t('reviews.request')}
            variant="default"
            testId="request-review"
          >
            {(close) => (
              <RequestReviewForm
                tender={tender}
                onDone={() => {
                  close();
                  setDone(t('reviews.requested'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
        {access.canSubmit ? (
          <ActionDialog
            label={t('submission.submit')}
            title={t('submission.submit')}
            variant="default"
            testId="submit-tender"
          >
            {(close) => (
              <SubmitForm
                tender={tender}
                onDone={() => {
                  close();
                  setDone(t('submission.done'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
        {access.canRecordAward ? (
          <ActionDialog label={t('award.record')} title={t('award.record')} testId="record-award">
            {(close) => (
              <AwardForm
                tender={tender}
                onDone={() => {
                  close();
                  setDone(t('award.done'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
        {access.canRecordLoss ? (
          <ActionDialog label={t('loss.record')} title={t('loss.record')} testId="record-loss">
            {(close) => (
              <LossForm
                tender={tender}
                onDone={() => {
                  close();
                  setDone(t('loss.done'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
        {access.canCreateContract ? (
          <ActionDialog
            label={t('tenders.createContract')}
            title={t('tenders.createContract')}
            variant="default"
            testId="create-contract"
          >
            {() => <ContractFromTenderForm tender={tender} />}
          </ActionDialog>
        ) : null}
        {tender.submission !== null &&
        can('tender.submit') &&
        (tender.status === 'SUBMITTED' || tender.status === 'CLARIFICATION') ? (
          <ActionDialog label={t('submission.correct')} title={t('submission.correct')} testId="correct-submission">
            {(close) => (
              <SubmitForm
                tender={tender}
                correction
                onDone={() => {
                  close();
                  setDone(t('submission.corrected'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
        {access.canEdit ? (
          <ActionDialog label={t('edit')} title={t('tenders.edit')} testId="edit-tender">
            {(close) => (
              <EditTenderForm
                tender={tender}
                onDone={() => {
                  close();
                  setDone(t('saved'));
                }}
              />
            )}
          </ActionDialog>
        ) : null}
        {access.transitions.map((to) => (
          <ActionDialog
            key={to}
            label={t(`tenderTransitions.${to}`)}
            title={t(`tenderTransitions.${to}`)}
            testId={`transition-${to}`}
          >
            {(close) => (
              <TransitionForm
                tender={tender}
                to={to}
                onDone={() => {
                  close();
                  setDone(t('statusChanged'));
                }}
              />
            )}
          </ActionDialog>
        ))}
        {access.canDelete ? (
          <Button
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t('tenders.confirmDelete'))) {
                remove.mutate(
                  () =>
                    requestEmpty(() =>
                      api.DELETE('/api/v1/tenders/{id}', {
                        params: { path: { id: tender.id }, query: { version: tender.version } },
                      }),
                    ),
                  {
                    onSuccess: () => {
                      router.push('/tenders');
                    },
                  },
                );
              }
            }}
          >
            {t('tenders.delete')}
          </Button>
        ) : null}
      </div>
      <FormError error={remove.error} />
      {done === null ? null : <StatusMessage>{done}</StatusMessage>}
    </section>
  );
}

function TransitionForm({
  tender,
  to,
  onDone,
}: {
  readonly tender: Tender;
  readonly to: TenderStatus;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [reason, setReason] = useState('');
  const needsReason = to === 'CANCELLED' || to === 'NO_BID';
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = optional(reason);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/transition', {
            params: { path: { id: tender.id } },
            body: { version: tender.version, to, ...(text === undefined ? {} : { reason: text }) },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <Field label={t('fields.reason')} optional={!needsReason} errorCode={fieldErrorsOf(action.error).get('reason')}>
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
        {action.isPending ? t('saving') : t(`tenderTransitions.${to}`)}
      </Button>
    </form>
  );
}

function EditTenderForm({ tender, onDone }: { readonly tender: Tender; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const organization = useOrganization();
  const deadlineEditable = tender.status === 'DRAFT' || tender.status === 'NEW';
  const [draft, setDraft] = useState({
    title: tender.title,
    description: tender.description ?? '',
    internalReference: tender.internalReference ?? '',
    deadline: '',
  });
  const [priority, setPriority] = useState<CommercialPriority | ''>(tender.priority);
  const [owner, setOwner] = useState<PickedEmployee | null>({ id: tender.owner.memberId, fullName: tender.owner.name });
  const errors = fieldErrorsOf(action.error);
  const timeZone = organization.data?.timeZone ?? 'UTC';
  const deadline = zonedInputToIso(draft.deadline, timeZone);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = {
      version: tender.version,
      title: draft.title.trim(),
      description: optional(draft.description) ?? null,
      internalReference: optional(draft.internalReference) ?? null,
      ...(priority === '' ? {} : { priority }),
      ...(owner === null || owner.id === tender.owner.memberId ? {} : { ownerMemberId: owner.id }),
      ...(deadlineEditable && deadline !== undefined
        ? { submissionDeadlineAt: deadline, submissionDeadlineTimeZone: timeZone }
        : {}),
    };
    action.mutate(
      () => request(() => api.PATCH('/api/v1/tenders/{id}', { params: { path: { id: tender.id } }, body })),
      {
        onSuccess: onDone,
      },
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
      <Field label={t('fields.internalReference')} errorCode={errors.get('internalReference')} optional>
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
      <SelectField
        label={t('fields.priority')}
        value={priority}
        options={PRIORITIES.map((value) => [value, t(`priorities.${value}`)] as const)}
        onChange={setPriority}
      />
      {deadlineEditable ? (
        <Field
          label={t('fields.deadline')}
          errorCode={errors.get('submissionDeadlineAt')}
          optional
          hint={`${t('tenders.deadlineHint', { timeZone })} ${t('tenders.deadlineEditHint')}`}
        >
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              value={draft.deadline}
              onChange={(event) => {
                setDraft({ ...draft, deadline: event.target.value });
              }}
            />
          )}
        </Field>
      ) : (
        <p className="text-xs text-muted-foreground">{t('tenders.deadlineViaAddendum')}</p>
      )}
      <Field label={t('fields.description')} errorCode={errors.get('description')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={4}
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

function BidDecisionForm({ tender, onDone }: { readonly tender: Tender; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [decision, setDecision] = useState<'BID' | 'NO_BID' | ''>('BID');
  const [criteria, setCriteria] = useState<Criteria>(() => {
    const initial: Record<string, CriterionValue> = {};
    for (const key of BID_CRITERIA) initial[key] = 'NOT_EVALUATED';
    return initial as Criteria;
  });
  const [reason, setReason] = useState<NoBidReason | ''>('');
  const [comments, setComments] = useState('');
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (decision === '') return;
    const text = optional(comments);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/bid-decision', {
            params: { path: { id: tender.id } },
            body: {
              version: tender.version,
              decision,
              criteria,
              ...(decision === 'NO_BID' && reason !== '' ? { noBidReason: reason } : {}),
              ...(text === undefined ? {} : { comments: text }),
            },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-medium">{t('bid.criteria')}</legend>
        {BID_CRITERIA.map((key) => (
          <SelectField
            key={key}
            label={t(`bidCriteria.${key}`)}
            value={criteria[key]}
            options={(['YES', 'NO', 'NOT_EVALUATED'] as const).map(
              (value) => [value, t(`criterionValues.${value}`)] as const,
            )}
            onChange={(value) => {
              if (value !== '') setCriteria({ ...criteria, [key]: value });
            }}
          />
        ))}
      </fieldset>
      <SelectField
        label={t('fields.bidDecision')}
        value={decision}
        options={(['BID', 'NO_BID'] as const).map((value) => [value, t(`bidDecisions.${value}`)] as const)}
        onChange={setDecision}
      />
      {decision === 'NO_BID' ? (
        <SelectField
          label={t('fields.noBidReason')}
          value={reason}
          options={NO_BID_REASONS.map((value) => [value, t(`noBidReasons.${value}`)] as const)}
          onChange={setReason}
          allowEmpty
        />
      ) : null}
      <Field label={t('fields.comments')} optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            maxLength={2000}
            value={comments}
            onChange={(event) => {
              setComments(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={action.isPending || decision === '' || (decision === 'NO_BID' && reason === '')}>
        {action.isPending ? t('saving') : t('bid.confirm')}
      </Button>
    </form>
  );
}

function RequestReviewForm({ tender, onDone }: { readonly tender: Tender; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [reviewers, setReviewers] = useState<Partial<Record<ReviewGateType, PickedEmployee | null>>>({});
  const [enabled, setEnabled] = useState<ReadonlySet<ReviewGateType>>(() => new Set(['FINAL']));
  const gates = REVIEW_GATES.filter((gate) => enabled.has(gate));
  const complete = gates.length > 0 && gates.every((gate) => reviewers[gate] != null);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = {
      version: tender.version,
      gates: gates.flatMap((gate) => {
        const reviewer = reviewers[gate];
        return reviewer == null ? [] : [{ gate, mode: 'ANY_ONE' as const, reviewerMemberIds: [reviewer.id] }];
      }),
    };
    action.mutate(
      () => request(() => api.POST('/api/v1/tenders/{id}/reviews', { params: { path: { id: tender.id } }, body })),
      {
        onSuccess: onDone,
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <p className="text-sm text-muted-foreground">{t('reviews.requestHint')}</p>
      {REVIEW_GATES.map((gate) => (
        <div key={gate} className="flex flex-col gap-2 rounded-md border p-3">
          <label className="flex min-h-11 items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={enabled.has(gate)}
              onChange={(event) => {
                const next = new Set(enabled);
                if (event.target.checked) next.add(gate);
                else next.delete(gate);
                setEnabled(next);
              }}
            />
            {t(`reviewGates.${gate}`)}
          </label>
          {enabled.has(gate) ? (
            <EmployeePicker
              label={t('reviews.reviewer', { gate: t(`reviewGates.${gate}`) })}
              value={reviewers[gate] ?? null}
              onChange={(value) => {
                setReviewers({ ...reviewers, [gate]: value });
              }}
              identity="member"
            />
          ) : null}
        </div>
      ))}
      <Button type="submit" disabled={action.isPending || !complete}>
        {action.isPending ? t('saving') : t('reviews.request')}
      </Button>
    </form>
  );
}

function SubmitForm({
  tender,
  correction = false,
  onDone,
}: {
  readonly tender: Tender;
  readonly correction?: boolean;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [key] = useState(newIdempotencyKey);
  const [method, setMethod] = useState<SubmissionMethod | ''>('GOVERNMENT_PORTAL');
  const [evidence, setEvidence] = useState('');
  const [draft, setDraft] = useState(() => ({ reference: '', notes: '', submittedAt: nowLocalInput(), reason: '' }));
  const documents = useParentDocuments('tenders', tender.id);
  const evidenceOptions = (documents.data?.items ?? []).flatMap((document) => {
    const current = document.versions.find((version) => version.isCurrent);
    return document.archivedAt === null && current !== undefined
      ? [[current.id, `${document.title} · ${t('documents.version', { number: current.versionNumber })}`] as const]
      : [];
  });
  const submittedAt = localInputToIso(draft.submittedAt);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (method === '' || submittedAt === undefined) return;
    const reference = optional(draft.reference);
    const notes = optional(draft.notes);
    const common = {
      method,
      submittedAt,
      ...(reference === undefined ? {} : { reference }),
      ...(notes === undefined ? {} : { notes }),
      ...(evidence === '' ? {} : { evidenceVersionId: evidence }),
    };
    const header = { 'Idempotency-Key': key };
    action.mutate(
      () =>
        correction
          ? request(() =>
              api.POST('/api/v1/tenders/{id}/submission/corrections', {
                params: { path: { id: tender.id }, header },
                body: { ...common, reason: draft.reason.trim() },
              }),
            )
          : request(() =>
              api.POST('/api/v1/tenders/{id}/submission', {
                params: { path: { id: tender.id }, header },
                body: { ...common, version: tender.version },
              }),
            ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <SelectField
        label={t('fields.submissionMethod')}
        value={method}
        options={SUBMISSION_METHODS.map((value) => [value, t(`submissionMethods.${value}`)] as const)}
        onChange={setMethod}
      />
      <SelectField
        label={t('fields.evidence')}
        value={evidence}
        options={evidenceOptions}
        onChange={setEvidence}
        optional
        allowEmpty
      />
      <Field label={t('fields.submittedAt')}>
        {(control) => (
          <Input
            {...control}
            type="datetime-local"
            required
            value={draft.submittedAt}
            onChange={(event) => {
              setDraft({ ...draft, submittedAt: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.reference')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={200}
            value={draft.reference}
            onChange={(event) => {
              setDraft({ ...draft, reference: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.notes')} optional>
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
      {correction ? (
        <Field label={t('fields.reason')}>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              required
              maxLength={1000}
              value={draft.reason}
              onChange={(event) => {
                setDraft({ ...draft, reason: event.target.value });
              }}
            />
          )}
        </Field>
      ) : (
        <p className="text-xs text-muted-foreground">{t('submission.hint')}</p>
      )}
      <Button
        type="submit"
        disabled={
          action.isPending || method === '' || submittedAt === undefined || (correction && draft.reason.trim() === '')
        }
      >
        {action.isPending ? t('saving') : correction ? t('submission.correct') : t('submission.confirm')}
      </Button>
    </form>
  );
}

function AwardForm({ tender, onDone }: { readonly tender: Tender; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [draft, setDraft] = useState(() => ({
    awardDate: todayInput(),
    value: '',
    currency: tender.estimatedValue?.currency ?? 'EGP',
    reference: '',
    notes: '',
  }));
  const value = amountOrUndefined(draft.value);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reference = optional(draft.reference);
    const notes = optional(draft.notes);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/award', {
            params: { path: { id: tender.id } },
            body: {
              version: tender.version,
              awardDate: draft.awardDate,
              ...(value === undefined ? {} : { awardValue: value, awardCurrency: draft.currency.trim().toUpperCase() }),
              ...(reference === undefined ? {} : { awardReference: reference }),
              ...(notes === undefined ? {} : { awardNotes: notes }),
            },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  const field = (key: keyof typeof draft, label: string, type = 'text', required = false) => (
    <Field label={label} optional={!required}>
      {(control) => (
        <Input
          {...control}
          type={type}
          required={required}
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
      {field('awardDate', t('fields.awardDate'), 'date', true)}
      {tender.access.canViewFinancial ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {field('value', t('fields.awardValue'))}
          {field('currency', t('fields.currency'))}
        </div>
      ) : null}
      {field('reference', t('fields.reference'))}
      {field('notes', t('fields.notes'))}
      <Button
        type="submit"
        disabled={action.isPending || draft.awardDate === '' || (draft.value.trim() !== '' && value === undefined)}
      >
        {action.isPending ? t('saving') : t('award.record')}
      </Button>
    </form>
  );
}

function LossForm({ tender, onDone }: { readonly tender: Tender; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [reason, setReason] = useState<LossReason | ''>('PRICE');
  const [draft, setDraft] = useState({
    winningCompany: '',
    winningValue: '',
    ourSubmittedValue: '',
    debriefNotes: '',
    lessonsLearned: '',
  });
  const winningValue = amountOrUndefined(draft.winningValue);
  const ourValue = amountOrUndefined(draft.ourSubmittedValue);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (reason === '') return;
    const company = optional(draft.winningCompany);
    const debrief = optional(draft.debriefNotes);
    const lessons = optional(draft.lessonsLearned);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/loss', {
            params: { path: { id: tender.id } },
            body: {
              version: tender.version,
              lossReason: reason,
              ...(company === undefined ? {} : { winningCompany: company }),
              ...(winningValue === undefined ? {} : { winningValue }),
              ...(ourValue === undefined ? {} : { ourSubmittedValue: ourValue }),
              ...(debrief === undefined ? {} : { debriefNotes: debrief }),
              ...(lessons === undefined ? {} : { lessonsLearned: lessons }),
            },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  const field = (key: keyof typeof draft, label: string, multiline = false) => (
    <Field label={label} optional>
      {(control) =>
        multiline ? (
          <Textarea
            {...control}
            rows={3}
            maxLength={5000}
            value={draft[key]}
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.target.value });
            }}
          />
        ) : (
          <Input
            {...control}
            value={draft[key]}
            onChange={(event) => {
              setDraft({ ...draft, [key]: event.target.value });
            }}
          />
        )
      }
    </Field>
  );
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <SelectField
        label={t('fields.lossReason')}
        value={reason}
        options={LOSS_REASONS.map((value) => [value, t(`lossReasons.${value}`)] as const)}
        onChange={setReason}
      />
      {field('winningCompany', t('fields.winningCompany'))}
      {tender.access.canViewFinancial ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {field('winningValue', t('fields.winningValue'))}
          {field('ourSubmittedValue', t('fields.ourSubmittedValue'))}
        </div>
      ) : null}
      {field('debriefNotes', t('fields.debriefNotes'), true)}
      {field('lessonsLearned', t('fields.lessonsLearned'), true)}
      <Button type="submit" disabled={action.isPending || reason === ''}>
        {action.isPending ? t('saving') : t('loss.record')}
      </Button>
    </form>
  );
}

function ContractFromTenderForm({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  const router = useRouter();
  const action = useCommercialAction<{ data: { id: string } }>();
  const [key] = useState(newIdempotencyKey);
  const [contractType, setContractType] = useState<ContractType | ''>('SUPPLY');
  const [draft, setDraft] = useState({ title: tender.title, expiryDate: '', startDate: '' });
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (contractType === '') return;
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/contract', {
            params: { path: { id: tender.id }, header: { 'Idempotency-Key': key } },
            body: {
              contractType,
              ...(draft.title.trim() === '' ? {} : { title: draft.title.trim() }),
              ...(draft.expiryDate === '' ? {} : { expiryDate: draft.expiryDate }),
              ...(draft.startDate === '' ? {} : { startDate: draft.startDate }),
            },
          }),
        ),
      {
        onSuccess: (created) => {
          router.push(`/contracts/${created.data.id}`);
        },
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <p className="text-sm text-muted-foreground">{t('tenders.createContractHint')}</p>
      <Field label={t('fields.title')}>
        {(control) => (
          <Input
            {...control}
            maxLength={300}
            value={draft.title}
            onChange={(event) => {
              setDraft({ ...draft, title: event.target.value });
            }}
          />
        )}
      </Field>
      <SelectField
        label={t('fields.contractType')}
        value={contractType}
        options={CONTRACT_TYPES.map((value) => [value, t(`contractTypes.${value}`)] as const)}
        onChange={setContractType}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('fields.startDate')} optional>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={draft.startDate}
              onChange={(event) => {
                setDraft({ ...draft, startDate: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label={t('fields.expiryDate')} optional>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={draft.expiryDate}
              onChange={(event) => {
                setDraft({ ...draft, expiryDate: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <Button type="submit" disabled={action.isPending || contractType === ''}>
        {action.isPending ? t('saving') : t('tenders.createContract')}
      </Button>
    </form>
  );
}

// ---- Requirements ----

const WORK_TARGETS: readonly RequirementStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'BLOCKED'];

/** The status changes the server allows this member on this requirement (mirrors the engine rule). */
function requirementTargets(requirement: TenderRequirement): RequirementStatus[] {
  const { canEdit: manager, canWork, canReview } = requirement.access;
  const from = requirement.status;
  const targets: RequirementStatus[] = [];
  if (from === 'NOT_APPLICABLE') {
    return manager ? ['NOT_STARTED'] : [];
  }
  if (from === 'READY_FOR_REVIEW' && canReview) {
    targets.push('APPROVED', 'CHANGES_REQUIRED');
  }
  if (canWork && (from !== 'APPROVED' || manager)) {
    targets.push(...WORK_TARGETS.filter((to) => to !== from));
  }
  if (manager) {
    targets.push('NOT_APPLICABLE');
  }
  return targets;
}

export function RequirementsTab({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  const requirements = useTenderRequirements(tender.id);
  return (
    <Section
      title={t('requirements.title')}
      actions={
        tender.access.canManageRequirements ? (
          <ActionDialog label={t('requirements.add')} title={t('requirements.add')} testId="add-requirement">
            {(close) => <RequirementForm tender={tender} onDone={close} />}
          </ActionDialog>
        ) : undefined
      }
    >
      {requirements.isPending ? (
        <ListSkeleton rows={4} />
      ) : requirements.isError ? (
        <ErrorState
          error={requirements.error}
          onRetry={() => {
            void requirements.refetch();
          }}
        />
      ) : requirements.data.length === 0 ? (
        <EmptyState message={t('requirements.empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="requirements">
          {requirements.data.map((requirement) => (
            <RequirementItem key={requirement.id} tender={tender} requirement={requirement} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function RequirementItem({
  tender,
  requirement,
}: {
  readonly tender: Tender;
  readonly requirement: TenderRequirement;
}) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const action = useCommercialAction();
  const [note, setNote] = useState('');
  const targets = requirementTargets(requirement);
  const setStatus = (status: RequirementStatus) => {
    const text = optional(note);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/requirements/{requirementId}/status', {
            params: { path: { id: tender.id, requirementId: requirement.id } },
            body: { version: requirement.version, status, ...(text === undefined ? {} : { note: text }) },
          }),
        ),
      {
        onSuccess: () => {
          setNote('');
        },
      },
    );
  };
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border p-4"
      data-testid="requirement"
      data-status={requirement.status}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium break-words">{requirement.title}</span>
          <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span>{t(`requirementCategories.${requirement.category}`)}</span>
            <span>·</span>
            <span>{requirement.mandatory ? t('requirements.mandatory') : t('requirements.optional')}</span>
            {requirement.referenceSection === null ? null : (
              <>
                <span>·</span>
                <span>{requirement.referenceSection}</span>
              </>
            )}
          </span>
        </div>
        <RequirementStatusBadge status={requirement.status} />
      </div>
      <Facts
        items={[
          [t('fields.owner'), person(requirement.owner, t('requirements.unassigned'))],
          [t('fields.reviewer'), person(requirement.reviewer)],
          [t('fields.dueDate'), <DueDate key="due" date={requirement.dueDate} overdue={requirement.overdue} />],
          [t('fields.priority'), t(`priorities.${requirement.priority}`)],
        ]}
      />
      {requirement.description === null ? null : (
        <p className="text-sm whitespace-pre-wrap">{requirement.description}</p>
      )}
      {requirement.links.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t('requirements.linkedDocuments')}</span>
          <ul className="flex flex-col gap-1 text-sm" data-testid="requirement-links">
            {requirement.links.map((link) => (
              <li key={link.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {link.document.title} · {t('documents.version', { number: link.document.versionNumber })}
                </span>
                {link.document.validOnDeadline === false ? (
                  <Badge tone="danger" data-testid="link-invalid-on-deadline">
                    {t('requirements.expiresBeforeDeadline')}
                  </Badge>
                ) : null}
                {link.document.isCurrentVersion ? null : (
                  <Badge tone="warning">{t('requirements.notCurrentVersion')}</Badge>
                )}
                {requirement.access.canLink ? (
                  <UnlinkButton tenderId={tender.id} requirementId={requirement.id} linkId={link.id} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
      {targets.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <label className="sr-only" htmlFor={`note-${requirement.id}`}>
            {t('fields.note')}
          </label>
          <Input
            id={`note-${requirement.id}`}
            placeholder={t('requirements.notePlaceholder')}
            maxLength={2000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
          <div className="flex flex-wrap gap-2">
            {targets.map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === 'APPROVED' || to === 'READY_FOR_REVIEW' ? 'default' : 'outline'}
                disabled={action.isPending}
                data-testid={`requirement-${to}`}
                onClick={() => {
                  setStatus(to);
                }}
              >
                {t(`requirementActions.${to}`)}
              </Button>
            ))}
          </div>
        </div>
      )}
      <FormError error={action.error} />
      <div className="flex flex-wrap gap-2">
        {requirement.access.canLink ? (
          <ActionDialog label={t('requirements.link')} title={t('requirements.link')} testId="link-document">
            {(close) => <LinkCorporateForm tenderId={tender.id} requirement={requirement} onDone={close} />}
          </ActionDialog>
        ) : null}
        {requirement.access.canEdit ? (
          <ActionDialog label={t('edit')} title={t('requirements.edit')}>
            {(close) => <RequirementForm tender={tender} requirement={requirement} onDone={close} />}
          </ActionDialog>
        ) : null}
        {requirement.access.canEdit ? <DeleteRequirementButton tenderId={tender.id} requirement={requirement} /> : null}
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">{t('requirements.evidence')}</summary>
        <div className="mt-2">
          <Attachments
            ownerType="TENDER_REQUIREMENT"
            ownerId={requirement.id}
            allowedTypes={COMMERCIAL_FILE_TYPES}
            maxBytes={COMMERCIAL_FILE_MAX_BYTES}
            hint={t('files.hint')}
            badType={t('files.badType')}
            tooLarge={t('files.tooLarge')}
            title={t('requirements.evidence')}
            testId="requirement-evidence"
            canUpload={requirement.access.canWork}
            canDelete={requirement.access.canEdit}
          />
        </div>
      </details>
    </li>
  );
}

function UnlinkButton({
  tenderId,
  requirementId,
  linkId,
}: {
  readonly tenderId: string;
  readonly requirementId: string;
  readonly linkId: string;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={action.isPending}
      onClick={() => {
        action.mutate(() =>
          requestEmpty(() =>
            api.DELETE('/api/v1/tenders/{id}/requirements/{requirementId}/links/{linkId}', {
              params: { path: { id: tenderId, requirementId, linkId } },
            }),
          ),
        );
      }}
    >
      {t('requirements.unlink')}
    </Button>
  );
}

function DeleteRequirementButton({
  tenderId,
  requirement,
}: {
  readonly tenderId: string;
  readonly requirement: TenderRequirement;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  return (
    <>
      <Button
        variant="ghost"
        disabled={action.isPending}
        onClick={() => {
          if (window.confirm(t('requirements.confirmDelete', { title: requirement.title }))) {
            action.mutate(() =>
              requestEmpty(() =>
                api.DELETE('/api/v1/tenders/{id}/requirements/{requirementId}', {
                  params: {
                    path: { id: tenderId, requirementId: requirement.id },
                    query: { version: requirement.version },
                  },
                }),
              ),
            );
          }
        }}
      >
        {t('delete')}
      </Button>
      <FormError error={action.error} />
    </>
  );
}

function RequirementForm({
  tender,
  requirement,
  onDone,
}: {
  readonly tender: Tender;
  readonly requirement?: TenderRequirement;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [category, setCategory] = useState<RequirementCategory | ''>(requirement?.category ?? 'TECHNICAL');
  const [priority, setPriority] = useState<CommercialPriority | ''>(requirement?.priority ?? 'MEDIUM');
  const [mandatory, setMandatory] = useState(requirement?.mandatory ?? true);
  const [owner, setOwner] = useState<PickedEmployee | null>(
    requirement?.owner == null ? null : { id: requirement.owner.memberId, fullName: requirement.owner.name },
  );
  const [reviewer, setReviewer] = useState<PickedEmployee | null>(
    requirement?.reviewer == null ? null : { id: requirement.reviewer.memberId, fullName: requirement.reviewer.name },
  );
  const [draft, setDraft] = useState({
    title: requirement?.title ?? '',
    description: requirement?.description ?? '',
    referenceSection: requirement?.referenceSection ?? '',
    dueDate: requirement?.dueDate ?? '',
  });
  const errors = fieldErrorsOf(action.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (category === '') return;
    const fields = {
      category,
      title: draft.title.trim(),
      description: optional(draft.description) ?? null,
      referenceSection: optional(draft.referenceSection) ?? null,
      dueDate: draft.dueDate === '' ? null : draft.dueDate,
      ownerMemberId: owner?.id ?? null,
      reviewerMemberId: reviewer?.id ?? null,
      mandatory,
      ...(priority === '' ? {} : { priority }),
    };
    action.mutate(
      () =>
        requirement === undefined
          ? request(() =>
              api.POST('/api/v1/tenders/{id}/requirements', { params: { path: { id: tender.id } }, body: fields }),
            )
          : request(() =>
              api.PATCH('/api/v1/tenders/{id}/requirements/{requirementId}', {
                params: { path: { id: tender.id, requirementId: requirement.id } },
                body: { ...fields, version: requirement.version },
              }),
            ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="requirement-form">
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
          options={REQUIREMENT_CATEGORIES.map((value) => [value, t(`requirementCategories.${value}`)] as const)}
          onChange={setCategory}
        />
        <SelectField
          label={t('fields.priority')}
          value={priority}
          options={PRIORITIES.map((value) => [value, t(`priorities.${value}`)] as const)}
          onChange={setPriority}
        />
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={mandatory}
          onChange={(event) => {
            setMandatory(event.target.checked);
          }}
        />
        {t('requirements.mandatory')}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('fields.referenceSection')} optional>
          {(control) => (
            <Input
              {...control}
              maxLength={200}
              value={draft.referenceSection}
              onChange={(event) => {
                setDraft({ ...draft, referenceSection: event.target.value });
              }}
            />
          )}
        </Field>
        <Field label={t('fields.dueDate')} optional errorCode={errors.get('dueDate')}>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={draft.dueDate}
              onChange={(event) => {
                setDraft({ ...draft, dueDate: event.target.value });
              }}
            />
          )}
        </Field>
      </div>
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
      <EmployeePicker
        label={t('fields.reviewer')}
        value={reviewer}
        onChange={setReviewer}
        identity="member"
        allowNone
      />
      <Button type="submit" disabled={action.isPending || draft.title.trim() === ''}>
        {action.isPending ? t('saving') : requirement === undefined ? t('requirements.add') : t('save')}
      </Button>
    </form>
  );
}

function LinkCorporateForm({
  tenderId,
  requirement,
  onDone,
}: {
  readonly tenderId: string;
  readonly requirement: TenderRequirement;
  readonly onDone: () => void;
}) {
  const t = useTranslations('commercial');
  const can = useCan();
  const action = useCommercialAction();
  const [documentId, setDocumentId] = useState('');
  const [note, setNote] = useState('');
  const documents = useCorporateDocuments({ status: 'ACTIVE' }, can('corporate_document.view'));
  const detail = useCorporateDocument(documentId === '' ? null : documentId);
  const current = detail.data?.versions.find((version) => version.isCurrent) ?? null;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (current === null) return;
    const text = optional(note);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/requirements/{requirementId}/links', {
            params: { path: { id: tenderId, requirementId: requirement.id } },
            body: { corporateDocumentVersionId: current.id, ...(text === undefined ? {} : { note: text }) },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  if (!can('corporate_document.view')) {
    return <p className="text-sm text-muted-foreground">{t('requirements.noVaultAccess')}</p>;
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <Field label={t('fields.document')}>
        {(control) => (
          <NativeSelect
            {...control}
            value={documentId}
            onChange={(event) => {
              setDocumentId(event.target.value);
            }}
          >
            <option value="">{t('requirements.chooseDocument')}</option>
            {(documents.data?.pages.flatMap((page) => page.data) ?? []).map((document) => (
              <option key={document.id} value={document.id}>
                {document.title} · {t(`validities.${document.validity}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {documentId !== '' && detail.isSuccess && current === null ? (
        <p className="text-sm text-destructive">{t('requirements.noCurrentVersion')}</p>
      ) : null}
      {current === null ? null : (
        <p className="text-sm text-muted-foreground">
          {t('documents.version', { number: current.versionNumber })} · {current.filename}
          {current.expiryDate === null ? '' : ` · ${t('fields.expiryDate')}: ${current.expiryDate}`}
        </p>
      )}
      <Field label={t('fields.note')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={1000}
            value={note}
            onChange={(event) => {
              setNote(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={action.isPending || current === null}>
        {action.isPending ? t('saving') : t('requirements.link')}
      </Button>
    </form>
  );
}

// ---- Reviews ----

export function ReviewsTab({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  const reviews = useTenderReviews(tender.id);
  if (reviews.isPending) return <ListSkeleton rows={3} />;
  if (reviews.isError) {
    return (
      <ErrorState
        error={reviews.error}
        onRetry={() => {
          void reviews.refetch();
        }}
      />
    );
  }
  return (
    <Section title={t('reviews.title')}>
      {reviews.data.length === 0 ? (
        <EmptyState message={t('reviews.empty')} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="review-gates">
          {reviews.data.map((gate) => (
            <GateItem key={gate.id} tender={tender} gate={gate} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function GateItem({ tender, gate }: { readonly tender: Tender; readonly gate: TenderReviewGate }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime } = useDateFormat();
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border p-4"
      data-testid="review-gate"
      data-gate={gate.gate}
      data-status={gate.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {t(`reviewGates.${gate.gate}`)} · {t('reviews.round', { round: gate.round })}
        </span>
        <Badge
          tone={
            gate.status === 'APPROVED'
              ? 'success'
              : gate.status === 'REJECTED' || gate.status === 'CHANGES_REQUIRED'
                ? 'danger'
                : 'neutral'
          }
        >
          {t(`gateStatuses.${gate.status}`)}
        </Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {gate.reviews.map((review) => (
          <li key={review.id} className="flex flex-col gap-1 text-sm">
            <span>
              {person(review.reviewer)} · {t(`reviewStatuses.${review.status}`)}
              {review.decidedAt === null ? '' : ` · ${dateTime(review.decidedAt)}`}
            </span>
            {review.comment === null ? null : <span className="text-muted-foreground">{review.comment}</span>}
            {review.canDecide ? <ReviewDecision tenderId={tender.id} reviewId={review.id} /> : null}
          </li>
        ))}
      </ul>
    </li>
  );
}

function ReviewDecision({ tenderId, reviewId }: { readonly tenderId: string; readonly reviewId: string }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [comment, setComment] = useState('');
  const decide = (decision: 'APPROVED' | 'CHANGES_REQUIRED' | 'REJECTED') => {
    const text = optional(comment);
    action.mutate(() =>
      request(() =>
        api.POST('/api/v1/tenders/{id}/reviews/{reviewId}/decision', {
          params: { path: { id: tenderId, reviewId } },
          body: { decision, ...(text === undefined ? {} : { comment: text }) },
        }),
      ),
    );
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-3" data-testid="review-decision">
      <label className="text-xs font-medium" htmlFor={`comment-${reviewId}`}>
        {t('fields.comments')}
      </label>
      <Textarea
        id={`comment-${reviewId}`}
        rows={2}
        maxLength={2000}
        value={comment}
        onChange={(event) => {
          setComment(event.target.value);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={action.isPending}
          onClick={() => {
            decide('APPROVED');
          }}
        >
          {t('reviews.approve')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={action.isPending}
          onClick={() => {
            decide('CHANGES_REQUIRED');
          }}
        >
          {t('reviews.changes')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={action.isPending}
          onClick={() => {
            decide('REJECTED');
          }}
        >
          {t('reviews.reject')}
        </Button>
      </div>
      <FormError error={action.error} />
    </div>
  );
}

// ---- Submission history and bid decisions ----

export function SubmissionTab({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime } = useDateFormat();
  const submissions = useTenderSubmissions(tender.id);
  const decisions = useBidDecisions(tender.id);
  return (
    <div className="flex flex-col gap-6">
      <Section title={t('submission.history')}>
        {submissions.isPending ? (
          <ListSkeleton rows={2} />
        ) : submissions.isError ? (
          <ErrorState error={submissions.error} />
        ) : submissions.data.length === 0 ? (
          <EmptyState message={t('submission.empty')} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="submissions">
            {submissions.data.map((submission) => (
              <li key={submission.id} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
                <span className="font-medium">
                  {t(`submissionKinds.${submission.kind}`)} · {t(`submissionMethods.${submission.method}`)}
                </span>
                <span className="text-muted-foreground">
                  {dateTime(submission.submittedAt)} · {person(submission.submittedBy)}
                  {submission.reference === null ? '' : ` · ${submission.reference}`}
                </span>
                {submission.notes === null ? null : <span>{submission.notes}</span>}
                {submission.evidence === null ? null : (
                  <span data-testid="submission-evidence">
                    {t('fields.evidence')}: {submission.evidence.title} ·{' '}
                    {t('documents.version', { number: submission.evidence.versionNumber })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t('bid.history')}>
        {decisions.isPending ? (
          <ListSkeleton rows={2} />
        ) : decisions.isError ? (
          <ErrorState error={decisions.error} />
        ) : decisions.data.length === 0 ? (
          <EmptyState message={t('bid.empty')} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="bid-decisions">
            {decisions.data.map((decision) => (
              <li key={decision.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
                <span className="font-medium">
                  {t(`bidDecisions.${decision.decision}`)} · {person(decision.decidedBy)} ·{' '}
                  {dateTime(decision.decidedAt)}
                </span>
                {decision.noBidReason === null ? null : <span>{t(`noBidReasons.${decision.noBidReason}`)}</span>}
                <ul className="grid gap-1 sm:grid-cols-2">
                  {BID_CRITERIA.map((key) => (
                    <li key={key} className="text-xs">
                      {t(`bidCriteria.${key}`)}: {t(`criterionValues.${decision.criteria[key]}`)}
                    </li>
                  ))}
                </ul>
                {decision.comments === null ? null : <span className="text-muted-foreground">{decision.comments}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ---- Addenda and clarifications ----

export function AddendaTab({ tender }: { readonly tender: Tender }) {
  const t = useTranslations('commercial');
  const { dateTime } = useDateFormat();
  const addenda = useTenderAddenda(tender.id);
  const clarifications = useTenderClarifications(tender.id);
  return (
    <div className="flex flex-col gap-6">
      <Section
        title={t('addenda.title')}
        actions={
          tender.access.canEdit ? (
            <ActionDialog label={t('addenda.add')} title={t('addenda.add')} testId="add-addendum">
              {(close) => <AddendumForm tender={tender} onDone={close} />}
            </ActionDialog>
          ) : undefined
        }
      >
        {addenda.isPending ? (
          <ListSkeleton rows={2} />
        ) : addenda.isError ? (
          <ErrorState error={addenda.error} />
        ) : addenda.data.length === 0 ? (
          <EmptyState message={t('addenda.empty')} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="addenda">
            {addenda.data.map((addendum) => (
              <li key={addendum.id} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
                <span className="font-medium">
                  {t('addenda.number', { number: addendum.number })}
                  {addendum.reference === null ? '' : ` · ${addendum.reference}`}
                </span>
                <span>{addendum.summary}</span>
                <span className="text-xs text-muted-foreground">{dateTime(addendum.receivedAt)}</span>
                {addendum.newDeadlineAt === null ? null : (
                  <span className="text-xs" data-testid="addendum-deadline">
                    {t('addenda.deadlineMoved', {
                      from:
                        addendum.previousDeadlineAt === null ? t('noDeadline') : dateTime(addendum.previousDeadlineAt),
                      to: dateTime(addendum.newDeadlineAt),
                    })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section
        title={t('clarifications.title')}
        actions={
          tender.access.canEdit ? (
            <ActionDialog label={t('clarifications.add')} title={t('clarifications.add')} testId="add-clarification">
              {(close) => <ClarificationForm tenderId={tender.id} onDone={close} />}
            </ActionDialog>
          ) : undefined
        }
      >
        {clarifications.isPending ? (
          <ListSkeleton rows={2} />
        ) : clarifications.isError ? (
          <ErrorState error={clarifications.error} />
        ) : clarifications.data.length === 0 ? (
          <EmptyState message={t('clarifications.empty')} />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="clarifications">
            {clarifications.data.map((clarification) => (
              <ClarificationItem key={clarification.id} tender={tender} clarification={clarification} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function AddendumForm({ tender, onDone }: { readonly tender: Tender; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const organization = useOrganization();
  const [draft, setDraft] = useState(() => ({
    summary: '',
    reference: '',
    receivedAt: nowLocalInput(),
    newDeadline: '',
  }));
  const timeZone = organization.data?.timeZone ?? 'UTC';
  const receivedAt = localInputToIso(draft.receivedAt);
  const newDeadline = zonedInputToIso(draft.newDeadline, timeZone);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (receivedAt === undefined) return;
    const reference = optional(draft.reference);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/addenda', {
            params: { path: { id: tender.id } },
            body: {
              version: tender.version,
              summary: draft.summary.trim(),
              receivedAt,
              ...(reference === undefined ? {} : { reference }),
              ...(newDeadline === undefined ? {} : { newDeadlineAt: newDeadline, newTimeZone: timeZone }),
            },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <Field label={t('fields.summary')}>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            required
            maxLength={2000}
            value={draft.summary}
            onChange={(event) => {
              setDraft({ ...draft, summary: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.reference')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={200}
            value={draft.reference}
            onChange={(event) => {
              setDraft({ ...draft, reference: event.target.value });
            }}
          />
        )}
      </Field>
      <Field label={t('fields.receivedAt')}>
        {(control) => (
          <Input
            {...control}
            type="datetime-local"
            required
            value={draft.receivedAt}
            onChange={(event) => {
              setDraft({ ...draft, receivedAt: event.target.value });
            }}
          />
        )}
      </Field>
      <Field
        label={t('fields.newDeadline')}
        optional
        hint={`${t('addenda.deadlineHint')} ${t('tenders.deadlineHint', { timeZone })}`}
      >
        {(control) => (
          <Input
            {...control}
            type="datetime-local"
            value={draft.newDeadline}
            onChange={(event) => {
              setDraft({ ...draft, newDeadline: event.target.value });
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={action.isPending || draft.summary.trim() === '' || receivedAt === undefined}>
        {action.isPending ? t('saving') : t('addenda.add')}
      </Button>
    </form>
  );
}

function ClarificationForm({ tenderId, onDone }: { readonly tenderId: string; readonly onDone: () => void }) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [question, setQuestion] = useState('');
  const [reference, setReference] = useState('');
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const ref = optional(reference);
    action.mutate(
      () =>
        request(() =>
          api.POST('/api/v1/tenders/{id}/clarifications', {
            params: { path: { id: tenderId } },
            body: { question: question.trim(), ...(ref === undefined ? {} : { reference: ref }) },
          }),
        ),
      { onSuccess: onDone },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <FormError error={action.error} />
      <Field label={t('fields.question')}>
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            required
            maxLength={5000}
            value={question}
            onChange={(event) => {
              setQuestion(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('fields.reference')} optional>
        {(control) => (
          <Input
            {...control}
            maxLength={200}
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
            }}
          />
        )}
      </Field>
      <Button type="submit" disabled={action.isPending || question.trim() === ''}>
        {action.isPending ? t('saving') : t('clarifications.add')}
      </Button>
    </form>
  );
}

function ClarificationItem({
  tender,
  clarification,
}: {
  readonly tender: Tender;
  readonly clarification: TenderClarification;
}) {
  const t = useTranslations('commercial');
  const action = useCommercialAction();
  const [response, setResponse] = useState(clarification.response ?? '');
  const update = (status: TenderClarification['status']) => {
    const text = optional(response);
    action.mutate(() =>
      request(() =>
        api.PATCH('/api/v1/tenders/{id}/clarifications/{clarificationId}', {
          params: { path: { id: tender.id, clarificationId: clarification.id } },
          body: { version: clarification.version, status, ...(text === undefined ? {} : { response: text }) },
        }),
      ),
    );
  };
  const open = clarification.status === 'OPEN' || clarification.status === 'SUBMITTED';
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-testid="clarification">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium whitespace-pre-wrap">{clarification.question}</span>
        <Badge>{t(`clarificationStatuses.${clarification.status}`)}</Badge>
      </div>
      {clarification.response === null ? null : (
        <p className="text-muted-foreground whitespace-pre-wrap">{clarification.response}</p>
      )}
      {tender.access.canEdit && open ? (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium" htmlFor={`response-${clarification.id}`}>
            {t('fields.response')}
          </label>
          <Textarea
            id={`response-${clarification.id}`}
            rows={2}
            maxLength={5000}
            value={response}
            onChange={(event) => {
              setResponse(event.target.value);
            }}
          />
          <div className="flex flex-wrap gap-2">
            {clarification.status === 'OPEN' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={action.isPending}
                onClick={() => {
                  update('SUBMITTED');
                }}
              >
                {t('clarifications.markSubmitted')}
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={action.isPending || response.trim() === ''}
              onClick={() => {
                update('ANSWERED');
              }}
            >
              {t('clarifications.markAnswered')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={action.isPending}
              onClick={() => {
                update('WITHDRAWN');
              }}
            >
              {t('clarifications.withdraw')}
            </Button>
          </div>
        </div>
      ) : null}
      <FormError error={action.error} />
    </li>
  );
}
