'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Input, Textarea } from '@company-ops/ui/components/input';

import { DetailCard, SelectField } from '../../../../components/commercial';
import { EmployeePicker } from '../../../../components/employee-picker';
import type { PickedEmployee } from '../../../../components/employee-picker';
import { Field, FormError, fieldErrorsOf } from '../../../../components/form';
import { Forbidden, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import {
  PRIORITIES,
  TENDER_TYPES,
  amountOrUndefined,
  useCommercialAction,
  zonedInputToIso,
} from '../../../../lib/commercial';
import type { CommercialPriority, TenderType } from '../../../../lib/commercial';
import { useCustomers, useProjects } from '../../../../lib/projects';
import { useOrganization } from '../../../../lib/queries';
import { useCan, useSession } from '../../../../lib/session';

export default function NewTenderPage() {
  const t = useTranslations('commercial');
  const can = useCan();
  if (!can('tender.create')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('tenders.new')} description={t('tenders.newDescription')} />
      <NewTenderForm />
    </>
  );
}

function NewTenderForm() {
  const t = useTranslations('commercial');
  const router = useRouter();
  const me = useSession();
  const can = useCan();
  const organization = useOrganization();
  const readsProjects = can('project.view');
  const customers = useCustomers({ enabled: readsProjects });
  const projects = useProjects({}, readsProjects);
  const action = useCommercialAction<{ data: { id: string } }>();
  const [owner, setOwner] = useState<PickedEmployee | null>({
    id: me.activeOrganization.memberId,
    fullName: me.user.displayName,
  });
  const [tenderType, setTenderType] = useState<TenderType | ''>('OPEN_TENDER');
  const [priority, setPriority] = useState<CommercialPriority | ''>('MEDIUM');
  const [draft, setDraft] = useState({
    title: '',
    internalReference: '',
    description: '',
    customerId: '',
    counterpartyName: '',
    relatedProjectId: '',
    procurementMethod: '',
    submissionDeadlineAt: '',
    clarificationDeadlineAt: '',
    estimatedValue: '',
    currency: 'EGP',
  });
  const errors = fieldErrorsOf(action.error);
  const timeZone = organization.data?.timeZone ?? 'UTC';
  const estimatedValue = amountOrUndefined(draft.estimatedValue);
  const deadline = zonedInputToIso(draft.submissionDeadlineAt, timeZone);
  const clarification = zonedInputToIso(draft.clarificationDeadlineAt, timeZone);

  const save = (status: 'DRAFT' | 'NEW') => {
    if (owner === null || tenderType === '') return;
    const body = {
      title: draft.title.trim(),
      tenderType,
      ownerMemberId: owner.id,
      status,
      ...(priority === '' ? {} : { priority }),
      ...(draft.internalReference.trim() === '' ? {} : { internalReference: draft.internalReference.trim() }),
      ...(draft.description.trim() === '' ? {} : { description: draft.description.trim() }),
      ...(draft.customerId === '' ? {} : { customerId: draft.customerId }),
      ...(draft.counterpartyName.trim() === '' ? {} : { counterpartyName: draft.counterpartyName.trim() }),
      ...(draft.relatedProjectId === '' ? {} : { relatedProjectId: draft.relatedProjectId }),
      ...(draft.procurementMethod.trim() === '' ? {} : { procurementMethod: draft.procurementMethod.trim() }),
      ...(deadline === undefined ? {} : { submissionDeadlineAt: deadline, submissionDeadlineTimeZone: timeZone }),
      ...(clarification === undefined ? {} : { clarificationDeadlineAt: clarification }),
      ...(estimatedValue === undefined ? {} : { estimatedValue, currency: draft.currency.trim().toUpperCase() }),
    };
    action.mutate(() => request(() => api.POST('/api/v1/tenders', { body })), {
      onSuccess: (created) => {
        router.push(`/tenders/${created.data.id}`);
      },
    });
  };
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save('DRAFT');
  };
  const text = (
    key: keyof typeof draft,
    label: string,
    props: {
      readonly optional?: boolean;
      readonly type?: string;
      readonly maxLength?: number;
      readonly hint?: string;
    } = {},
  ) => (
    <Field label={label} errorCode={errors.get(key)} optional={props.optional ?? true} hint={props.hint}>
      {(control) => (
        <Input
          {...control}
          type={props.type ?? 'text'}
          required={props.optional === false}
          maxLength={props.maxLength}
          value={draft[key]}
          onChange={(event) => {
            setDraft({ ...draft, [key]: event.target.value });
          }}
        />
      )}
    </Field>
  );
  const invalid =
    draft.title.trim() === '' ||
    owner === null ||
    (draft.estimatedValue.trim() !== '' && estimatedValue === undefined) ||
    (draft.submissionDeadlineAt !== '' && deadline === undefined);

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-4" data-testid="tender-form">
      <FormError error={action.error} />
      <DetailCard>
        {text('title', t('fields.title'), { optional: false, maxLength: 300 })}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('fields.tenderType')}
            value={tenderType}
            options={TENDER_TYPES.map((value) => [value, t(`tenderTypes.${value}`)] as const)}
            onChange={setTenderType}
            errorCode={errors.get('tenderType')}
          />
          <SelectField
            label={t('fields.priority')}
            value={priority}
            options={PRIORITIES.map((value) => [value, t(`priorities.${value}`)] as const)}
            onChange={setPriority}
            errorCode={errors.get('priority')}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {text('internalReference', t('fields.internalReference'), { maxLength: 100 })}
          {text('procurementMethod', t('fields.procurementMethod'), { maxLength: 200 })}
        </div>
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
      </DetailCard>
      <DetailCard>
        <div className="grid gap-4 sm:grid-cols-2">
          {customers.isSuccess ? (
            <SelectField
              label={t('fields.customer')}
              value={draft.customerId}
              options={customers.data.pages
                .flatMap((page) => page.data)
                .map((customer) => [customer.id, customer.name] as const)}
              onChange={(value) => {
                setDraft({ ...draft, customerId: value });
              }}
              errorCode={errors.get('customerId')}
              optional
              allowEmpty
            />
          ) : null}
          {text('counterpartyName', t('fields.counterparty'), { maxLength: 300, hint: t('tenders.counterpartyHint') })}
          {projects.isSuccess ? (
            <SelectField
              label={t('fields.relatedProject')}
              value={draft.relatedProjectId}
              options={projects.data.pages
                .flatMap((page) => page.data)
                .map((project) => [project.id, `${project.code} · ${project.name}`] as const)}
              onChange={(value) => {
                setDraft({ ...draft, relatedProjectId: value });
              }}
              errorCode={errors.get('relatedProjectId')}
              optional
              allowEmpty
            />
          ) : null}
        </div>
      </DetailCard>
      <DetailCard>
        <div className="grid gap-4 sm:grid-cols-2">
          {text('submissionDeadlineAt', t('fields.deadline'), {
            type: 'datetime-local',
            hint: t('tenders.deadlineHint', { timeZone }),
          })}
          {text('clarificationDeadlineAt', t('fields.clarificationDeadline'), {
            type: 'datetime-local',
            hint: t('tenders.deadlineHint', { timeZone }),
          })}
        </div>
        {can('tender.financial.view') ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {text('estimatedValue', t('fields.estimatedValue'), { maxLength: 20, hint: t('money.hint') })}
            {text('currency', t('fields.currency'), { maxLength: 3 })}
          </div>
        ) : null}
        <EmployeePicker label={t('fields.owner')} value={owner} onChange={setOwner} identity="member" />
      </DetailCard>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={action.isPending || invalid}>
          {action.isPending ? t('saving') : t('tenders.saveDraft')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={action.isPending || invalid || deadline === undefined}
          onClick={() => {
            save('NEW');
          }}
        >
          {t('tenders.saveNew')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('tenders.newHint')}</p>
    </form>
  );
}
