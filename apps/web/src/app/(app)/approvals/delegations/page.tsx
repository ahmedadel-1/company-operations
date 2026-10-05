'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { EmployeePicker } from '../../../../components/employee-picker';
import type { PickedEmployee } from '../../../../components/employee-picker';
import { Field, fieldErrorsOf, FormError, StatusMessage } from '../../../../components/form';
import { usePersonName } from '../../../../components/requests';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import { useDateFormat } from '../../../../lib/format';
import {
  REQUEST_LIMITS,
  requestKeys,
  useAdminRequestTypes,
  useDelegations,
  useLocalized,
} from '../../../../lib/requests';
import type { Delegation, DelegationStatus } from '../../../../lib/requests';
import { useCan, useCanOrgWide, useSession } from '../../../../lib/session';

const STATUS_TONES: Readonly<Record<DelegationStatus, 'neutral' | 'success' | 'warning'>> = {
  SCHEDULED: 'warning',
  ACTIVE: 'success',
  EXPIRED: 'neutral',
  REVOKED: 'neutral',
};

/** `YYYY-MM-DDTHH:mm` in local time for `datetime-local` inputs. */
function localInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function DelegationsPage() {
  const t = useTranslations();
  const can = useCan();
  const orgWide = useCanOrgWide();
  const admin = orgWide('request.admin');
  const [view, setView] = useState<'mine' | 'all'>('mine');
  if (!can('request.approve')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('approvals.delegation.title')} description={t('approvals.delegation.description')} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          {admin ? (
            <div className="flex flex-col gap-1.5 sm:max-w-xs">
              <Label htmlFor="delegations-view">{t('requests.view')}</Label>
              <NativeSelect
                id="delegations-view"
                value={view}
                onChange={(event) => {
                  setView(event.target.value === 'all' ? 'all' : 'mine');
                }}
              >
                <option value="mine">{t('approvals.delegation.views.mine')}</option>
                <option value="all">{t('approvals.delegation.views.all')}</option>
              </NativeSelect>
            </div>
          ) : null}
          <DelegationList view={view} />
        </div>
        <CreateDelegation admin={admin} />
      </div>
    </>
  );
}

function DelegationList({ view }: { readonly view: 'mine' | 'all' }) {
  const t = useTranslations();
  const delegations = useDelegations(view);
  const rows = delegations.data?.pages.flatMap((page) => page.data) ?? [];
  if (delegations.isPending) return <ListSkeleton rows={3} />;
  if (delegations.isError) {
    return (
      <ErrorState
        error={delegations.error}
        onRetry={() => {
          void delegations.refetch();
        }}
      />
    );
  }
  if (rows.length === 0) return <EmptyState message={t('approvals.delegation.empty')} />;
  return (
    <>
      <ul className="flex flex-col gap-3" aria-label={t('approvals.delegation.title')} data-testid="delegation-list">
        {rows.map((item) => (
          <DelegationRow key={item.id} item={item} view={view} />
        ))}
      </ul>
      {delegations.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={delegations.isFetchingNextPage}
          onClick={() => {
            void delegations.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </Button>
      ) : null}
    </>
  );
}

function DelegationRow({ item, view }: { readonly item: Delegation; readonly view: 'mine' | 'all' }) {
  const t = useTranslations();
  const me = useSession();
  const localized = useLocalized();
  const person = usePersonName();
  const { dateTime } = useDateFormat();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/approval-delegations/{id}/revoke', {
          params: { path: { id: item.id } },
          body: { version: item.version },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['requests', 'delegations'] });
      await queryClient.invalidateQueries({ queryKey: requestKeys.approvals });
    },
  });
  const mine = me.activeOrganization.memberId;
  const title =
    item.delegator.memberId === mine
      ? t('approvals.delegation.given', { name: person(item.delegate) })
      : item.delegate.memberId === mine
        ? t('approvals.delegation.received', { name: person(item.delegator) })
        : t('approvals.delegation.between', { from: person(item.delegator), to: person(item.delegate) });
  return (
    <li
      className="flex flex-col gap-2 rounded-lg border p-4"
      data-testid="delegation-row"
      data-status={item.status}
      data-view={view}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{title}</span>
        <Badge tone={STATUS_TONES[item.status]}>{t(`approvals.delegation.statuses.${item.status}`)}</Badge>
      </div>
      <span className="text-sm text-muted-foreground">
        {t('approvals.delegation.period', { from: dateTime(item.startsAt), to: dateTime(item.endsAt) })}
      </span>
      <span className="text-sm">
        {item.requestType === null
          ? t('approvals.delegation.allTypes')
          : t('approvals.delegation.onlyType', { name: localized(item.requestType.name) })}
      </span>
      {item.reason === null ? null : <span className="text-sm whitespace-pre-wrap">{item.reason}</span>}
      <FormError error={revoke.error} />
      {item.canRevoke ? (
        <Button
          variant="outline"
          className="self-start"
          disabled={revoke.isPending}
          onClick={() => {
            if (window.confirm(t('approvals.delegation.confirmRevoke'))) revoke.mutate();
          }}
        >
          {t('approvals.delegation.revoke')}
        </Button>
      ) : null}
    </li>
  );
}

function CreateDelegation({ admin }: { readonly admin: boolean }) {
  const t = useTranslations();
  const localized = useLocalized();
  const queryClient = useQueryClient();
  const types = useAdminRequestTypes(admin);
  const [delegator, setDelegator] = useState<PickedEmployee | null>(null);
  const [delegate, setDelegate] = useState<PickedEmployee | null>(null);
  const [requestTypeId, setRequestTypeId] = useState('');
  const [startsAt, setStartsAt] = useState(() => localInput(new Date()));
  const [endsAt, setEndsAt] = useState(() => localInput(new Date(Date.now() + 7 * 86_400_000)));
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      request(() =>
        api.POST('/api/v1/approval-delegations', {
          body: {
            ...(delegator === null ? {} : { delegatorMemberId: delegator.id }),
            delegateMemberId: delegate?.id ?? '',
            ...(requestTypeId === '' ? {} : { requestTypeId }),
            startsAt: new Date(startsAt).toISOString(),
            endsAt: new Date(endsAt).toISOString(),
            ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
          },
        }),
      ),
    onSuccess: async () => {
      setDone(true);
      setDelegate(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['requests', 'delegations'] });
    },
  });
  const errors = fieldErrorsOf(create.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDone(false);
    create.mutate();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('approvals.delegation.create')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4" data-testid="delegation-form">
          <p className="text-sm text-muted-foreground">
            {t('approvals.delegation.createHint', { days: REQUEST_LIMITS.maxDelegationDays })}
          </p>
          <FormError error={create.error} />
          {admin ? (
            <EmployeePicker
              label={t('approvals.delegation.delegator')}
              identity="member"
              allowNone
              value={delegator}
              onChange={setDelegator}
            />
          ) : null}
          <EmployeePicker
            label={t('approvals.delegation.delegate')}
            identity="member"
            value={delegate}
            onChange={setDelegate}
          />
          {admin ? (
            <Field label={t('approvals.delegation.requestType')} optional errorCode={errors.get('requestTypeId')}>
              {(control) => (
                <NativeSelect
                  {...control}
                  value={requestTypeId}
                  onChange={(event) => {
                    setRequestTypeId(event.target.value);
                  }}
                >
                  <option value="">{t('approvals.delegation.allTypes')}</option>
                  {(types.data ?? []).map((type) => (
                    <option key={type.id} value={type.id}>
                      {localized(type.name)}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </Field>
          ) : null}
          <Field label={t('approvals.delegation.startsAt')} errorCode={errors.get('startsAt')}>
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                required
                value={startsAt}
                onChange={(event) => {
                  setStartsAt(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('approvals.delegation.endsAt')} errorCode={errors.get('endsAt')}>
            {(control) => (
              <Input
                {...control}
                type="datetime-local"
                required
                min={startsAt}
                value={endsAt}
                onChange={(event) => {
                  setEndsAt(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('approvals.delegation.reason')} optional errorCode={errors.get('reason')}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" disabled={create.isPending || delegate === null || startsAt === '' || endsAt === ''}>
            {create.isPending ? t('common.saving') : t('approvals.delegation.save')}
          </Button>
          {done ? <StatusMessage>{t('approvals.delegation.saved')}</StatusMessage> : null}
        </form>
      </CardContent>
    </Card>
  );
}
