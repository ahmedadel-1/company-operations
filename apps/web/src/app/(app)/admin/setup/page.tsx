'use client';

import { CheckCircle2Icon, CircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Badge } from '@company-ops/ui/components/badge';

import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { useSetupChecklist } from '../../../../lib/dashboard';
import { linkHref } from '../../../../lib/link-params';
import { useCanOrgWide } from '../../../../lib/session';

/** First-run checklist (P8-7): every item is derived from the organization's real state on each load. */
export default function SetupChecklistPage() {
  const t = useTranslations('setup');
  const orgWide = useCanOrgWide();
  const allowed = orgWide('org.settings.manage');
  const checklist = useSetupChecklist(allowed);
  if (!allowed) {
    return <Forbidden />;
  }
  const data = checklist.data;
  const requiredDone = data?.items.filter((item) => !item.optional && item.done).length ?? 0;
  return (
    <>
      <PageHeader
        title={t('title')}
        description={
          data === undefined ? t('description') : t('progress', { done: requiredDone, total: data.required })
        }
      />
      {checklist.isPending ? (
        <ListSkeleton rows={8} />
      ) : checklist.isError || data === undefined ? (
        <ErrorState
          error={checklist.error}
          onRetry={() => {
            void checklist.refetch();
          }}
        />
      ) : (
        <ol className="flex flex-col gap-2" aria-label={t('title')} data-testid="setup-checklist">
          {data.items.map((item) => (
            <li
              key={item.key}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
              data-testid="setup-item"
              data-key={item.key}
              data-done={item.done ? 'true' : 'false'}
            >
              <span className="flex min-w-0 items-start gap-3">
                {item.done ? (
                  <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success" />
                ) : (
                  <CircleIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                )}
                <span className="flex flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {t(`items.${item.key}.title`)}
                    <span className="sr-only">{item.done ? t('done') : t('notDone')}</span>
                    {item.optional ? <Badge>{t('optional')}</Badge> : null}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {item.done ? t(`items.${item.key}.done`, { count: item.count }) : t(`items.${item.key}.todo`)}
                  </span>
                </span>
              </span>
              <Link
                href={linkHref(item.link)}
                className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
              >
                {item.done ? t('review') : t('start')}
                <span className="sr-only"> {t(`items.${item.key}.title`)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
