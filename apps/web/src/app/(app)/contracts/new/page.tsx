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
import { CONTRACT_TYPES, RENEWAL_TYPES, amountOrUndefined, useCommercialAction } from '../../../../lib/commercial';
import type { ContractType, RenewalType } from '../../../../lib/commercial';
import { useCustomers, useProjects } from '../../../../lib/projects';
import { useCan, useSession } from '../../../../lib/session';

export default function NewContractPage() {
  const t = useTranslations('commercial');
  const can = useCan();
  if (!can('contract.create')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('contracts.new')} description={t('contracts.newDescription')} />
      <NewContractForm />
    </>
  );
}

function NewContractForm() {
  const t = useTranslations('commercial');
  const router = useRouter();
  const me = useSession();
  const can = useCan();
  const readsProjects = can('project.view');
  const customers = useCustomers({ enabled: readsProjects });
  const projects = useProjects({}, readsProjects);
  const action = useCommercialAction<{ data: { id: string } }>();
  const [owner, setOwner] = useState<PickedEmployee | null>({
    id: me.activeOrganization.memberId,
    fullName: me.user.displayName,
  });
  const [contractType, setContractType] = useState<ContractType | ''>('SERVICES');
  const [renewalType, setRenewalType] = useState<RenewalType | ''>('FIXED_TERM');
  const [draft, setDraft] = useState({
    title: '',
    internalReference: '',
    description: '',
    customerId: '',
    counterpartyName: '',
    projectId: '',
    originalValue: '',
    currency: 'EGP',
    signedDate: '',
    startDate: '',
    expiryDate: '',
    noticePeriodDays: '',
  });
  const errors = fieldErrorsOf(action.error);
  const value = amountOrUndefined(draft.originalValue);
  const notice = /^\d{1,4}$/.test(draft.noticePeriodDays.trim())
    ? Number.parseInt(draft.noticePeriodDays, 10)
    : undefined;
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (owner === null || contractType === '' || value === undefined) return;
    const optional = (text: string) => (text.trim() === '' ? undefined : text.trim());
    const internalReference = optional(draft.internalReference);
    const description = optional(draft.description);
    const counterpartyName = optional(draft.counterpartyName);
    const body = {
      title: draft.title.trim(),
      contractType,
      currency: draft.currency.trim().toUpperCase(),
      originalValue: value,
      ownerMemberId: owner.id,
      ...(renewalType === '' ? {} : { renewalType }),
      ...(internalReference === undefined ? {} : { internalReference }),
      ...(description === undefined ? {} : { description }),
      ...(counterpartyName === undefined ? {} : { counterpartyName }),
      ...(draft.customerId === '' ? {} : { customerId: draft.customerId }),
      ...(draft.projectId === '' ? {} : { projectId: draft.projectId }),
      ...(draft.signedDate === '' ? {} : { signedDate: draft.signedDate }),
      ...(draft.startDate === '' ? {} : { startDate: draft.startDate }),
      ...(draft.expiryDate === '' ? {} : { expiryDate: draft.expiryDate }),
      ...(notice === undefined ? {} : { noticePeriodDays: notice }),
    };
    action.mutate(() => request(() => api.POST('/api/v1/contracts', { body })), {
      onSuccess: (created) => {
        router.push(`/contracts/${created.data.id}`);
      },
    });
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

  return (
    <form onSubmit={submit} className="flex max-w-3xl flex-col gap-4" data-testid="contract-form">
      <FormError error={action.error} />
      <DetailCard>
        {text('title', t('fields.title'), { optional: false, maxLength: 300 })}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label={t('fields.contractType')}
            value={contractType}
            options={CONTRACT_TYPES.map((option) => [option, t(`contractTypes.${option}`)] as const)}
            onChange={setContractType}
            errorCode={errors.get('contractType')}
          />
          <SelectField
            label={t('fields.renewalType')}
            value={renewalType}
            options={RENEWAL_TYPES.map((option) => [option, t(`renewalTypes.${option}`)] as const)}
            onChange={setRenewalType}
            errorCode={errors.get('renewalType')}
          />
        </div>
        {text('internalReference', t('fields.internalReference'), { maxLength: 100 })}
        <Field label={t('fields.description')} errorCode={errors.get('description')} optional>
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
              onChange={(option) => {
                setDraft({ ...draft, customerId: option });
              }}
              optional
              allowEmpty
            />
          ) : null}
          {text('counterpartyName', t('fields.counterparty'), { maxLength: 300 })}
          {projects.isSuccess ? (
            <SelectField
              label={t('fields.project')}
              value={draft.projectId}
              options={projects.data.pages
                .flatMap((page) => page.data)
                .map((project) => [project.id, `${project.code} · ${project.name}`] as const)}
              onChange={(option) => {
                setDraft({ ...draft, projectId: option });
              }}
              optional
              allowEmpty
            />
          ) : null}
        </div>
      </DetailCard>
      <DetailCard>
        <div className="grid gap-4 sm:grid-cols-2">
          {text('originalValue', t('fields.originalValue'), { optional: false, maxLength: 20, hint: t('money.hint') })}
          {text('currency', t('fields.currency'), { optional: false, maxLength: 3 })}
          {text('signedDate', t('fields.signedDate'), { type: 'date' })}
          {text('startDate', t('fields.startDate'), { type: 'date' })}
          {text('expiryDate', t('fields.expiryDate'), { type: 'date' })}
          {text('noticePeriodDays', t('fields.noticePeriod'), { type: 'number' })}
        </div>
        <EmployeePicker label={t('fields.owner')} value={owner} onChange={setOwner} identity="member" />
      </DetailCard>
      <div>
        <Button
          type="submit"
          disabled={action.isPending || draft.title.trim() === '' || owner === null || value === undefined}
        >
          {action.isPending ? t('saving') : t('contracts.create')}
        </Button>
      </div>
    </form>
  );
}
