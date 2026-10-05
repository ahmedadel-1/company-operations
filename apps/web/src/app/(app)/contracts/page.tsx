'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { ContractList } from '../../../components/commercial';
import { LinkedFilterNotice, WithLinkParams } from '../../../components/linked-filter';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { CONTRACT_STATUSES, HEALTHS, useContracts } from '../../../lib/commercial';
import type { ContractQuery } from '../../../lib/commercial';
import { csvOf, oneOf, uuidOf } from '../../../lib/link-params';
import { useCan } from '../../../lib/session';

const VIEWS = ['all', 'mine'] as const;
const SORTS = ['expiry:asc', 'updatedAt:desc', 'number:desc'] as const;
const FLAGS = [
  'renewalRequired',
  'noticeApproaching',
  'overdueObligations',
  'overdueMilestones',
  'guaranteesExpiring',
] as const;
type Flag = (typeof FLAGS)[number];

export default function ContractsPage() {
  const t = useTranslations('commercial');
  const can = useCan();
  if (!can('contract.view')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('contracts.title')}
        description={t('contracts.description')}
        actions={
          can('contract.create') ? (
            <Button asChild>
              <Link href="/contracts/new">
                <PlusIcon aria-hidden="true" />
                {t('contracts.new')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <WithLinkParams fallback={<ListSkeleton rows={6} />}>
        {(params) => <ContractQueue params={params} />}
      </WithLinkParams>
    </>
  );
}

function initialParams(params: URLSearchParams) {
  const status = csvOf(params.get('status'), CONTRACT_STATUSES);
  const health = csvOf(params.get('health'), HEALTHS);
  const within = params.get('expiringWithinDays');
  const expiringWithinDays = within !== null && /^\d{1,4}$/.test(within) ? Number.parseInt(within, 10) : undefined;
  const flags = FLAGS.filter((flag) => params.get(flag) === 'true');
  const projectId = uuidOf(params.get('projectId'));
  const customerId = uuidOf(params.get('customerId'));
  const sourceTenderId = uuidOf(params.get('sourceTenderId'));
  const ownerMemberId = uuidOf(params.get('ownerMemberId'));
  const hidden: ContractQuery = {
    ...(status !== undefined && status.length > 1 ? { status: status.join(',') } : {}),
    ...(health !== undefined && health.length > 1 ? { health: health.join(',') } : {}),
    ...(expiringWithinDays === undefined ? {} : { expiringWithinDays }),
    ...Object.fromEntries(flags.map((flag) => [flag, 'true' as const])),
    ...(projectId === undefined ? {} : { projectId }),
    ...(customerId === undefined ? {} : { customerId }),
    ...(sourceTenderId === undefined ? {} : { sourceTenderId }),
    ...(ownerMemberId === undefined ? {} : { ownerMemberId }),
  };
  return {
    view: oneOf(params.get('view'), VIEWS) ?? 'all',
    q: params.get('q')?.slice(0, 100) ?? '',
    status: status?.length === 1 ? (status[0] ?? '') : '',
    health: health?.length === 1 ? (health[0] ?? '') : '',
    hidden,
  };
}

function ContractQueue({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations('commercial');
  const tc = useTranslations('common');
  const [initial] = useState(() => initialParams(params));
  const [draft, setDraft] = useState({
    view: initial.view,
    q: initial.q,
    status: initial.status,
    health: initial.health,
    sort: 'expiry:asc',
  });
  const [hidden, setHidden] = useState<ContractQuery>(initial.hidden);
  const toFilters = (source: typeof draft): ContractQuery => {
    const view = oneOf(source.view, VIEWS);
    const status = oneOf(source.status, CONTRACT_STATUSES);
    const health = oneOf(source.health, HEALTHS);
    const sort = oneOf(source.sort, SORTS);
    return {
      ...(view === undefined || view === 'all' ? {} : { view }),
      ...(source.q.trim() === '' ? {} : { q: source.q.trim() }),
      ...(status === undefined ? {} : { status }),
      ...(health === undefined ? {} : { health }),
      ...(sort === undefined || sort === 'expiry:asc' ? {} : { sort }),
    };
  };
  const [filters, setFilters] = useState<ContractQuery>(() => toFilters(draft));
  const contracts = useContracts({ ...hidden, ...filters });
  const rows = contracts.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = Object.keys(filters).some((key) => key !== 'sort') || Object.keys(hidden).length > 0;
  const hiddenParts = [
    hidden.status === undefined
      ? null
      : hidden.status
          .split(',')
          .map((value) =>
            CONTRACT_STATUSES.some((status) => status === value) ? t(`contractStatuses.${value as 'ACTIVE'}`) : value,
          )
          .join(', '),
    hidden.health === undefined
      ? null
      : hidden.health
          .split(',')
          .map((value) => (HEALTHS.some((health) => health === value) ? t(`healths.${value as 'AT_RISK'}`) : value))
          .join(', '),
    hidden.expiringWithinDays === undefined
      ? null
      : t('contracts.linked.expiringWithin', { days: hidden.expiringWithinDays }),
    ...FLAGS.map((flag: Flag) => (hidden[flag] === 'true' ? t(`contracts.linked.${flag}`) : null)),
    hidden.projectId === undefined ? null : t('tenders.linked.project'),
    hidden.customerId === undefined ? null : t('tenders.linked.customer'),
    hidden.sourceTenderId === undefined ? null : t('contracts.linked.sourceTender'),
    hidden.ownerMemberId === undefined ? null : t('tenders.linked.owner'),
  ].filter((part): part is string => part !== null);

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters(toFilters(draft));
  };
  const select = (
    key: keyof typeof draft,
    label: string,
    options: readonly (readonly [string, string])[],
    all = true,
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`contract-${key}`}>{label}</Label>
      <NativeSelect
        id={`contract-${key}`}
        value={draft[key]}
        onChange={(event) => {
          setDraft({ ...draft, [key]: event.target.value });
        }}
      >
        {all ? <option value="">{tc('all')}</option> : null}
        {options.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </NativeSelect>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={apply}
        role="search"
        aria-label={t('filters')}
        className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
      >
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="contract-q">{t('search')}</Label>
          <Input
            id="contract-q"
            type="search"
            maxLength={100}
            placeholder={t('contracts.searchPlaceholder')}
            value={draft.q}
            onChange={(event) => {
              setDraft({ ...draft, q: event.target.value });
            }}
          />
        </div>
        {select(
          'view',
          t('view'),
          VIEWS.map((value) => [value, t(`views.${value}`)] as const),
          false,
        )}
        {select(
          'status',
          t('fields.status'),
          CONTRACT_STATUSES.map((value) => [value, t(`contractStatuses.${value}`)] as const),
        )}
        {select(
          'health',
          t('fields.health'),
          HEALTHS.map((value) => [value, t(`healths.${value}`)] as const),
        )}
        {select(
          'sort',
          t('sort'),
          SORTS.map((value) => [value, t(`contracts.sorts.${value.replace(':', '_') as 'expiry_asc'}`)] as const),
          false,
        )}
        <Button type="submit" variant="outline" className="lg:col-start-4">
          {tc('apply')}
        </Button>
      </form>
      {hiddenParts.length === 0 ? null : (
        <LinkedFilterNotice
          description={hiddenParts.join(' · ')}
          onClear={() => {
            setHidden({});
          }}
        />
      )}
      {contracts.isPending ? (
        <ListSkeleton />
      ) : contracts.isError ? (
        <ErrorState
          error={contracts.error}
          onRetry={() => {
            void contracts.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={filtered ? t('contracts.emptyFiltered') : t('contracts.empty')} />
      ) : (
        <>
          <ContractList contracts={rows} label={t('contracts.title')} />
          {contracts.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={contracts.isFetchingNextPage}
              onClick={() => {
                void contracts.fetchNextPage();
              }}
            >
              {contracts.isFetchingNextPage ? tc('loading') : tc('loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
