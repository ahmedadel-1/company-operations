'use client';

import { ListTodoIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { TenderList } from '../../../components/commercial';
import { LinkedFilterNotice, WithLinkParams } from '../../../components/linked-filter';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { TENDER_STATUSES, useTenders } from '../../../lib/commercial';
import type { TenderQuery } from '../../../lib/commercial';
import { useDateFormat } from '../../../lib/format';
import { csvOf, dateOf, oneOf, uuidOf } from '../../../lib/link-params';
import { useCan } from '../../../lib/session';

const VIEWS = ['all', 'mine'] as const;
const DEADLINES = ['next7', 'next30', 'overdue'] as const;
const READINESS = ['not_ready', 'ready', 'no_mandatory'] as const;
const SORTS = ['deadline:asc', 'updatedAt:desc', 'number:desc'] as const;

export default function TendersPage() {
  const t = useTranslations('commercial');
  const can = useCan();
  if (!can('tender.view') && !can('tender.create')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('tenders.title')}
        description={t('tenders.description')}
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/tenders/my-work">
                <ListTodoIcon aria-hidden="true" />
                {t('work.title')}
              </Link>
            </Button>
            {can('tender.create') ? (
              <Button asChild>
                <Link href="/tenders/new">
                  <PlusIcon aria-hidden="true" />
                  {t('tenders.new')}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />
      <WithLinkParams fallback={<ListSkeleton rows={6} />}>
        {(params) => <TenderQueue params={params} />}
      </WithLinkParams>
    </>
  );
}

/** Filters a dashboard link carries; the form shows what it can, the rest is listed in a notice. */
function initialParams(params: URLSearchParams) {
  const status = csvOf(params.get('status'), TENDER_STATUSES);
  const stage = oneOf(params.get('stage'), ['final_approval'] as const);
  const submittedFrom = dateOf(params.get('submittedFrom'));
  const awardedFrom = dateOf(params.get('awardedFrom'));
  const closedFrom = dateOf(params.get('closedFrom'));
  const projectId = uuidOf(params.get('projectId'));
  const customerId = uuidOf(params.get('customerId'));
  const ownerMemberId = uuidOf(params.get('ownerMemberId'));
  const hidden: TenderQuery = {
    ...(status !== undefined && status.length > 1 ? { status: status.join(',') } : {}),
    ...(stage === undefined ? {} : { stage }),
    ...(submittedFrom === undefined ? {} : { submittedFrom }),
    ...(awardedFrom === undefined ? {} : { awardedFrom }),
    ...(closedFrom === undefined ? {} : { closedFrom }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(customerId === undefined ? {} : { customerId }),
    ...(ownerMemberId === undefined ? {} : { ownerMemberId }),
  };
  return {
    view: oneOf(params.get('view'), VIEWS) ?? 'all',
    q: params.get('q')?.slice(0, 100) ?? '',
    status: status?.length === 1 ? (status[0] ?? '') : '',
    deadline: oneOf(params.get('deadline'), DEADLINES) ?? '',
    readiness: oneOf(params.get('readiness'), READINESS) ?? '',
    hidden,
  };
}

function TenderQueue({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations('commercial');
  const tc = useTranslations('common');
  const { date } = useDateFormat();
  const [initial] = useState(() => initialParams(params));
  const [draft, setDraft] = useState({
    view: initial.view,
    q: initial.q,
    status: initial.status,
    deadline: initial.deadline,
    readiness: initial.readiness,
    sort: 'deadline:asc',
  });
  const [hidden, setHidden] = useState<TenderQuery>(initial.hidden);
  const toFilters = (source: typeof draft): TenderQuery => {
    const view = oneOf(source.view, VIEWS);
    const status = oneOf(source.status, TENDER_STATUSES);
    const deadline = oneOf(source.deadline, DEADLINES);
    const readiness = oneOf(source.readiness, READINESS);
    const sort = oneOf(source.sort, SORTS);
    return {
      ...(view === undefined || view === 'all' ? {} : { view }),
      ...(source.q.trim() === '' ? {} : { q: source.q.trim() }),
      ...(status === undefined ? {} : { status }),
      ...(deadline === undefined ? {} : { deadline }),
      ...(readiness === undefined ? {} : { readiness }),
      ...(sort === undefined || sort === 'deadline:asc' ? {} : { sort }),
    };
  };
  const [filters, setFilters] = useState<TenderQuery>(() => toFilters(draft));
  const tenders = useTenders({ ...hidden, ...filters });
  const rows = tenders.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = Object.keys(filters).some((key) => key !== 'sort') || Object.keys(hidden).length > 0;
  const hiddenParts = [
    hidden.status === undefined
      ? null
      : hidden.status
          .split(',')
          .map((value) =>
            TENDER_STATUSES.some((status) => status === value) ? t(`tenderStatuses.${value as 'NEW'}`) : value,
          )
          .join(', '),
    hidden.stage === undefined ? null : t('tenders.linked.finalApproval'),
    hidden.submittedFrom === undefined
      ? null
      : t('tenders.linked.submittedSince', { date: date(hidden.submittedFrom) }),
    hidden.awardedFrom === undefined ? null : t('tenders.linked.awardedSince', { date: date(hidden.awardedFrom) }),
    hidden.closedFrom === undefined ? null : t('tenders.linked.closedSince', { date: date(hidden.closedFrom) }),
    hidden.projectId === undefined ? null : t('tenders.linked.project'),
    hidden.customerId === undefined ? null : t('tenders.linked.customer'),
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
      <Label htmlFor={`tender-${key}`}>{label}</Label>
      <NativeSelect
        id={`tender-${key}`}
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
          <Label htmlFor="tender-q">{t('search')}</Label>
          <Input
            id="tender-q"
            type="search"
            maxLength={100}
            placeholder={t('tenders.searchPlaceholder')}
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
          TENDER_STATUSES.map((value) => [value, t(`tenderStatuses.${value}`)] as const),
        )}
        {select(
          'deadline',
          t('fields.deadline'),
          DEADLINES.map((value) => [value, t(`tenders.deadlines.${value}`)] as const),
        )}
        {select(
          'readiness',
          t('fields.readiness'),
          READINESS.map((value) => [value, t(`tenders.readinessFilters.${value}`)] as const),
        )}
        {select(
          'sort',
          t('sort'),
          SORTS.map((value) => [value, t(`tenders.sorts.${value.replace(':', '_') as 'deadline_asc'}`)] as const),
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
      {tenders.isPending ? (
        <ListSkeleton />
      ) : tenders.isError ? (
        <ErrorState
          error={tenders.error}
          onRetry={() => {
            void tenders.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={filtered ? t('tenders.emptyFiltered') : t('tenders.empty')} />
      ) : (
        <>
          <TenderList tenders={rows} label={t('tenders.title')} />
          {tenders.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={tenders.isFetchingNextPage}
              onClick={() => {
                void tenders.fetchNextPage();
              }}
            >
              {tenders.isFetchingNextPage ? tc('loading') : tc('loadMore')}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
