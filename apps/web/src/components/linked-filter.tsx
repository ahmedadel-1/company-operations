'use client';

import { FilterIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Fragment, Suspense } from 'react';
import type { ReactNode } from 'react';

import { Button } from '@company-ops/ui/components/button';

type ParamsChildren = (params: URLSearchParams) => ReactNode;

/**
 * Hands a list the query string of the URL being shown (correct during client-side navigation, unlike
 * `window.location`). The list remounts when the query changes, so its filter state starts from the
 * new link instead of keeping the previous one.
 */
export function WithLinkParams({
  fallback,
  children,
}: {
  readonly fallback: ReactNode;
  readonly children: ParamsChildren;
}) {
  return (
    <Suspense fallback={fallback}>
      <CurrentParams>{children}</CurrentParams>
    </Suspense>
  );
}

function CurrentParams({ children }: { readonly children: ParamsChildren }) {
  const search = useSearchParams().toString();
  return <Fragment key={search}>{children(new URLSearchParams(search))}</Fragment>;
}

/**
 * Says that a list shows exactly the rows a dashboard number counted (filters the form cannot show,
 * such as several statuses or a resolution window), and offers to clear them.
 */
export function LinkedFilterNotice({
  description,
  onClear,
}: {
  readonly description: string;
  readonly onClear: () => void;
}) {
  const t = useTranslations('dashboard');
  return (
    <div
      role="status"
      data-testid="linked-filter"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-4 py-2 text-sm"
    >
      <span className="flex items-center gap-2">
        <FilterIcon aria-hidden="true" className="size-4 text-muted-foreground" />
        {t('linkedFilter', { description })}
      </span>
      <Button variant="ghost" size="sm" onClick={onClear}>
        {t('clearLinkedFilter')}
      </Button>
    </div>
  );
}
