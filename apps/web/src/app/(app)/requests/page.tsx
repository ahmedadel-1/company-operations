'use client';

import { PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { WithLinkParams } from '../../../components/linked-filter';
import { RequestList } from '../../../components/requests';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { csvOf } from '../../../lib/link-params';
import { REQUEST_STATUSES, useLocalized, useRequestCatalog, useRequests } from '../../../lib/requests';
import type { RequestListQuery } from '../../../lib/requests';
import { useCan, useSession } from '../../../lib/session';

type View = 'mine' | 'all';

export default function RequestsPage() {
  return (
    <WithLinkParams fallback={<ListSkeleton rows={4} />}>{(params) => <Requests params={params} />}</WithLinkParams>
  );
}

function Requests({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations();
  const can = useCan();
  const me = useSession();
  // `all` lists what the member's request.view scope covers (team, department, projects, organization).
  const beyondSelf = me.permissions.some(
    (grant) => grant.key === 'request.view' && grant.scopes.some((scope) => scope !== 'SELF'),
  );
  const [initial] = useState(() => ({
    view: params.get('view') === 'all' && beyondSelf ? ('all' as const) : ('mine' as const),
    status: csvOf(params.get('status'), REQUEST_STATUSES),
  }));
  const [view, setView] = useState<View>(initial.view);
  const [draft, setDraft] = useState({
    q: '',
    status: initial.status?.length === 1 ? (initial.status[0] ?? '') : '',
    requestTypeId: '',
  });
  const [filters, setFilters] = useState<Omit<RequestListQuery, 'view'>>(
    initial.status === undefined ? {} : { status: initial.status.join(',') },
  );
  const catalog = useRequestCatalog(can('request.create'));
  const localized = useLocalized();
  const requests = useRequests({ view, ...filters });
  const rows = requests.data?.pages.flatMap((page) => page.data) ?? [];
  const filtered = Object.keys(filters).length > 0;

  if (!can('request.view') && !can('request.create')) {
    return <Forbidden />;
  }

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const status = REQUEST_STATUSES.find((value) => value === draft.status);
    setFilters({
      ...(draft.q.trim() === '' ? {} : { q: draft.q.trim() }),
      ...(status === undefined ? {} : { status }),
      ...(draft.requestTypeId === '' ? {} : { requestTypeId: draft.requestTypeId }),
    });
  };

  return (
    <>
      <PageHeader
        title={t('requests.title')}
        description={t('requests.description')}
        actions={
          can('request.create') ? (
            <Button asChild>
              <Link href="/requests/new">
                <PlusIcon aria-hidden="true" />
                {t('requests.new')}
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-4">
        {beyondSelf ? (
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="requests-view">{t('requests.view')}</Label>
            <NativeSelect
              id="requests-view"
              value={view}
              onChange={(event) => {
                setView(event.target.value === 'all' ? 'all' : 'mine');
              }}
            >
              <option value="mine">{t('requests.views.mine')}</option>
              <option value="all">{t('requests.views.all')}</option>
            </NativeSelect>
          </div>
        ) : null}
        <form
          onSubmit={apply}
          role="search"
          aria-label={t('requests.filters')}
          className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="requests-q">{t('requests.search')}</Label>
            <Input
              id="requests-q"
              type="search"
              maxLength={40}
              placeholder={t('requests.searchPlaceholder')}
              value={draft.q}
              onChange={(event) => {
                setDraft({ ...draft, q: event.target.value });
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="requests-status">{t('requests.status')}</Label>
            <NativeSelect
              id="requests-status"
              value={draft.status}
              onChange={(event) => {
                setDraft({ ...draft, status: event.target.value });
              }}
            >
              <option value="">{t('common.all')}</option>
              {REQUEST_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`requests.statuses.${status}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="requests-type">{t('requests.type')}</Label>
            <NativeSelect
              id="requests-type"
              value={draft.requestTypeId}
              onChange={(event) => {
                setDraft({ ...draft, requestTypeId: event.target.value });
              }}
            >
              <option value="">{t('common.all')}</option>
              {(catalog.data ?? []).map((type) => (
                <option key={type.id} value={type.id}>
                  {localized(type.name)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button type="submit" variant="outline">
            {t('common.apply')}
          </Button>
        </form>
        {requests.isPending ? (
          <ListSkeleton />
        ) : requests.isError ? (
          <ErrorState
            error={requests.error}
            onRetry={() => {
              void requests.refetch();
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            message={
              filtered ? t('requests.emptyFiltered') : view === 'mine' ? t('requests.emptyMine') : t('requests.empty')
            }
            action={
              can('request.create') && !filtered && view === 'mine' ? (
                <Button asChild variant="outline">
                  <Link href="/requests/new">{t('requests.new')}</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <RequestList requests={rows} label={t(`requests.views.${view}`)} showRequester={view === 'all'} />
            {requests.hasNextPage ? (
              <Button
                variant="outline"
                className="self-center"
                disabled={requests.isFetchingNextPage}
                onClick={() => {
                  void requests.fetchNextPage();
                }}
              >
                {requests.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
