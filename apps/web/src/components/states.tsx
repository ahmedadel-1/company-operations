'use client';

import { AlertTriangleIcon, LockIcon, SearchXIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Skeleton } from '@company-ops/ui/components/skeleton';

import { ApiError } from '../lib/api';

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Layout-shaped placeholder while a region loads (UI_UX.md §5). */
export function ListSkeleton({ rows = 6 }: { readonly rows?: number }) {
  const t = useTranslations('common');
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3">
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ message, action }: { readonly message: string; readonly action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed p-8 text-center">
      <p className="text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}

export function Forbidden() {
  const t = useTranslations('states');
  return (
    <StatePanel
      icon={<LockIcon aria-hidden="true" className="size-8" />}
      title={t('forbiddenTitle')}
      body={t('forbiddenBody')}
    >
      <Button asChild variant="outline">
        <Link href="/">{t('backHome')}</Link>
      </Button>
    </StatePanel>
  );
}

export function NotFoundState() {
  const t = useTranslations('states');
  return (
    <StatePanel
      icon={<SearchXIcon aria-hidden="true" className="size-8" />}
      title={t('notFoundTitle')}
      body={t('notFoundBody')}
    >
      <Button asChild variant="outline">
        <Link href="/">{t('backHome')}</Link>
      </Button>
    </StatePanel>
  );
}

function StatePanel({
  icon,
  title,
  body,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly body: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-12 text-center">
      <span className="text-muted-foreground">{icon}</span>
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}

export function useErrorMessage(): (error: unknown) => string {
  const t = useTranslations('errors');
  return (error) => {
    const code = error instanceof ApiError ? error.code : 'UNKNOWN';
    return t.has(code as 'UNKNOWN') ? t(code as 'UNKNOWN') : t('UNKNOWN');
  };
}

/** Translated `error.code`, a retry action and the request id for support (UI_UX.md §5). */
export function ErrorState({ error, onRetry }: { readonly error: unknown; readonly onRetry?: () => void }) {
  const t = useTranslations();
  const message = useErrorMessage();
  if (error instanceof ApiError && error.status === 403) {
    return <Forbidden />;
  }
  if (error instanceof ApiError && error.status === 404) {
    return <NotFoundState />;
  }
  if (error instanceof ApiError && error.status === 401) {
    // The shell replaces the page with the session-expired or MFA screen.
    return <ListSkeleton rows={2} />;
  }
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4">
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangleIcon aria-hidden="true" className="size-4 text-destructive" />
        {message(error)}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        {onRetry === undefined ? null : (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
        {error instanceof ApiError && error.requestId !== null ? (
          <details className="text-sm text-muted-foreground">
            <summary className="cursor-pointer">{t('common.details')}</summary>
            <p className="mt-1">
              {t('common.requestId')}: <code className="select-all">{error.requestId}</code>
            </p>
          </details>
        ) : null}
      </div>
    </div>
  );
}
