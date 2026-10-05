'use client';

import { AlertTriangleIcon, UserCogIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Label, NativeSelect } from '@company-ops/ui/components/input';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';

import { StatusMessage } from '../../../components/form';
import { WithLinkParams } from '../../../components/linked-filter';
import { DecisionForm } from '../../../components/request-actions';
import { RequestTypeIconView, useDateSpan, usePersonName } from '../../../components/requests';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { useDateFormat } from '../../../lib/format';
import { useApprovals, useLocalized, useRequestCatalog } from '../../../lib/requests';
import type { ApprovalItem } from '../../../lib/requests';
import { useCan } from '../../../lib/session';

export default function ApprovalsPage() {
  return (
    <WithLinkParams fallback={<ListSkeleton rows={4} />}>{(params) => <Approvals params={params} />}</WithLinkParams>
  );
}

function Approvals({ params }: { readonly params: URLSearchParams }) {
  const t = useTranslations();
  const can = useCan();
  const localized = useLocalized();
  const [typeId, setTypeId] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(() => params.get('overdue') === 'true');
  const catalog = useRequestCatalog(can('request.create'));
  const approvals = useApprovals(typeId === '' ? null : typeId, overdueOnly);
  const [decision, setDecision] = useState<{ readonly item: ApprovalItem; readonly kind: 'approve' | 'reject' } | null>(
    null,
  );
  const [done, setDone] = useState<string | null>(null);
  const rows = approvals.data?.pages.flatMap((page) => page.data) ?? [];
  if (!can('request.approve')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader
        title={t('approvals.title')}
        description={t('approvals.description')}
        actions={
          <Button asChild variant="outline">
            <Link href="/approvals/delegations">
              <UserCogIcon aria-hidden="true" />
              {t('approvals.delegations')}
            </Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label htmlFor="approvals-type">{t('requests.type')}</Label>
            <NativeSelect
              id="approvals-type"
              value={typeId}
              onChange={(event) => {
                setTypeId(event.target.value);
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
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={overdueOnly}
              onChange={(event) => {
                setOverdueOnly(event.target.checked);
              }}
            />
            {t('approvals.overdueOnly')}
          </label>
        </div>
        {done === null ? null : <StatusMessage>{done}</StatusMessage>}
        {approvals.isPending ? (
          <ListSkeleton />
        ) : approvals.isError ? (
          <ErrorState
            error={approvals.error}
            onRetry={() => {
              void approvals.refetch();
            }}
          />
        ) : rows.length === 0 ? (
          <EmptyState message={t('approvals.empty')} />
        ) : (
          <ul className="flex flex-col gap-3" aria-label={t('approvals.title')} data-testid="approval-inbox">
            {rows.map((item) => (
              <ApprovalCard
                key={item.approvalId}
                item={item}
                onDecide={(kind) => {
                  setDone(null);
                  setDecision({ item, kind });
                }}
              />
            ))}
          </ul>
        )}
        {approvals.hasNextPage ? (
          <Button
            variant="outline"
            className="self-center"
            disabled={approvals.isFetchingNextPage}
            onClick={() => {
              void approvals.fetchNextPage();
            }}
          >
            {approvals.isFetchingNextPage ? t('common.loading') : t('common.loadMore')}
          </Button>
        ) : null}
      </div>
      <Dialog
        open={decision !== null}
        onOpenChange={(open) => {
          if (!open) setDecision(null);
        }}
      >
        {decision === null ? null : (
          <DialogContent
            title={`${decision.kind === 'approve' ? t('requests.decision.approve') : t('requests.decision.reject')} · ${decision.item.request.key}`}
            closeLabel={t('common.close')}
          >
            <DecisionForm
              requestId={decision.item.request.id}
              approvalId={decision.item.approvalId}
              decision={decision.kind}
              onDone={() => {
                setDone(
                  decision.kind === 'approve' ? t('requests.decision.approved') : t('requests.decision.rejected'),
                );
                setDecision(null);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

function ApprovalCard({
  item,
  onDecide,
}: {
  readonly item: ApprovalItem;
  readonly onDecide: (kind: 'approve' | 'reject') => void;
}) {
  const t = useTranslations();
  const localized = useLocalized();
  const person = usePersonName();
  const span = useDateSpan();
  const { dateTime } = useDateFormat();
  const dates = span(item.request.startsOn, item.request.endsOn);
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid="approval-item"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Link
          href={`/requests/${item.request.id}`}
          className="flex items-center gap-2 font-medium underline-offset-4 hover:underline"
        >
          <RequestTypeIconView icon={item.request.requestType.icon} className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{item.request.key}</span>
          {localized(item.request.requestType.name)}
        </Link>
        <span className="text-sm">
          {t('approvals.from', { name: person(item.request.requester) })}
          {dates === null ? '' : ` · ${dates}`}
        </span>
        <span className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          {t('approvals.step', { name: localized(item.step.name) })}
          {item.step.mode === 'ALL' ? <Badge>{t('requests.modes.ALL')}</Badge> : null}
          {item.onBehalfOf === null ? null : (
            <Badge data-testid="on-behalf-of">{t('approvals.onBehalfOf', { name: person(item.onBehalfOf) })}</Badge>
          )}
          {item.overdue ? (
            <Badge tone="danger">
              <AlertTriangleIcon aria-hidden="true" className="size-3" />
              {t('approvals.overdue')}
            </Badge>
          ) : item.dueAt === null ? null : (
            <span>{t('approvals.due', { date: dateTime(item.dueAt) })}</span>
          )}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button
          onClick={() => {
            onDecide('approve');
          }}
        >
          {t('requests.decision.approve')}
          <span className="sr-only"> {item.request.key}</span>
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            onDecide('reject');
          }}
        >
          {t('requests.decision.reject')}
          <span className="sr-only"> {item.request.key}</span>
        </Button>
      </div>
    </li>
  );
}
