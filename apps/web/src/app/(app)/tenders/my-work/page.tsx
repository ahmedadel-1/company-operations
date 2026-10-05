'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Label, NativeSelect } from '@company-ops/ui/components/input';

import { DueDate, RequirementStatusBadge, useCommercialPerson } from '../../../../components/commercial';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../../../../components/states';
import { TENDER_WORK_VIEWS, useTenderWork } from '../../../../lib/commercial';
import type { TenderWork, TenderWorkView } from '../../../../lib/commercial';
import { useDateFormat } from '../../../../lib/format';
import { useCan } from '../../../../lib/session';

type Bucket = TenderWork['items'][number]['bucket'];
const BUCKETS: readonly Bucket[] = [
  'OVERDUE',
  'DUE_TODAY',
  'BLOCKED',
  'REVIEW',
  'UPCOMING',
  'NO_DUE_DATE',
  'UNASSIGNED',
];

export default function TenderWorkPage() {
  const t = useTranslations('commercial');
  const can = useCan();
  const [view, setView] = useState<TenderWorkView>('mine');
  const views = TENDER_WORK_VIEWS.filter((value) => value === 'mine' || can('tender.manage_requirements'));
  return (
    <>
      <PageHeader title={t('work.title')} description={t('work.description')} />
      {views.length > 1 ? (
        <div className="mb-4 flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor="work-view">{t('view')}</Label>
          <NativeSelect
            id="work-view"
            value={view}
            onChange={(event) => {
              const next = views.find((value) => value === event.target.value);
              if (next !== undefined) setView(next);
            }}
          >
            {views.map((value) => (
              <option key={value} value={value}>
                {t(`work.views.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <WorkList view={view} />
    </>
  );
}

function WorkList({ view }: { readonly view: TenderWorkView }) {
  const t = useTranslations('commercial');
  const person = useCommercialPerson();
  const { dateTime } = useDateFormat();
  const work = useTenderWork(view);
  if (work.isPending) return <ListSkeleton />;
  if (work.isError) {
    return (
      <ErrorState
        error={work.error}
        onRetry={() => {
          void work.refetch();
        }}
      />
    );
  }
  const { items, reviews, truncated } = work.data;
  if (items.length === 0 && reviews.length === 0) {
    return <EmptyState message={t('work.empty')} />;
  }
  return (
    <div className="flex flex-col gap-6">
      {reviews.length === 0 ? null : (
        <section aria-labelledby="work-reviews" className="flex flex-col gap-2">
          <h2 id="work-reviews" className="text-lg font-semibold">
            {t('work.reviews')}
          </h2>
          <ul className="flex flex-col gap-2" data-testid="work-reviews">
            {reviews.map((review) => (
              <li key={review.reviewId}>
                <Link
                  href={`/tenders/${review.tender.id}#reviews`}
                  className="flex flex-col gap-1 rounded-lg border p-3 hover:bg-accent"
                >
                  <span className="font-medium">
                    {review.tender.key} · {review.tender.title}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`reviewGates.${review.gate}`)} · {dateTime(review.requestedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {BUCKETS.map((bucket) => {
        const rows = items.filter((item) => item.bucket === bucket);
        if (rows.length === 0) return null;
        return (
          <section key={bucket} aria-labelledby={`bucket-${bucket}`} className="flex flex-col gap-2">
            <h2 id={`bucket-${bucket}`} className="text-lg font-semibold">
              {t(`work.buckets.${bucket}`)} <span className="text-muted-foreground">({rows.length})</span>
            </h2>
            <ul className="flex flex-col gap-2" data-testid={`work-${bucket}`}>
              {rows.map((item) => (
                <li key={item.requirement.id}>
                  <Link
                    href={`/tenders/${item.tender.id}#requirements`}
                    className="flex flex-col gap-1 rounded-lg border p-3 hover:bg-accent"
                    data-testid="work-item"
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium break-words">{item.requirement.title}</span>
                      <RequirementStatusBadge status={item.requirement.status} />
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {item.tender.key} · {item.tender.title}
                    </span>
                    <span className="flex flex-wrap gap-3 text-sm">
                      <span>
                        {t('fields.dueDate')}:{' '}
                        <DueDate date={item.requirement.dueDate} overdue={item.requirement.overdue} />
                      </span>
                      <span>
                        {t('fields.owner')}: {person(item.requirement.owner, t('requirements.unassigned'))}
                      </span>
                      {item.requirement.mandatory ? <span>{t('requirements.mandatory')}</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {truncated ? <p className="text-sm text-muted-foreground">{t('work.truncated')}</p> : null}
    </div>
  );
}
