'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { cn } from '@company-ops/ui/lib/utils';

import { FormError } from '../../../components/form';
import { notificationHref, useNotificationText } from '../../../components/notification-text';
import { EmptyState, ErrorState, ListSkeleton, PageHeader } from '../../../components/states';
import { api, request } from '../../../lib/api';
import { useDateFormat } from '../../../lib/format';
import { useNotifications, useUnreadCount } from '../../../lib/queries';

export default function NotificationsPage() {
  const t = useTranslations();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const notifications = useNotifications(unreadOnly);
  const unread = useUnreadCount();
  const text = useNotificationText();
  const { dateTime } = useDateFormat();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const markOne = useMutation({
    mutationFn: (id: string) =>
      request(() => api.POST('/api/v1/notifications/{id}/read', { params: { path: { id } } })),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => request(() => api.POST('/api/v1/notifications/read-all')),
    onSuccess: invalidate,
  });
  const items = notifications.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <>
      <PageHeader
        title={t('notifications.title')}
        actions={
          <>
            {(unread.data ?? 0) > 0 ? (
              <Button
                variant="outline"
                disabled={markAll.isPending}
                onClick={() => {
                  markAll.mutate();
                }}
              >
                {t('notifications.markAllRead')}
              </Button>
            ) : null}
            <Button asChild variant="ghost">
              <Link href="/notifications/preferences">{t('notifications.preferences')}</Link>
            </Button>
          </>
        }
      />
      <label className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={unreadOnly}
          onChange={(event) => {
            setUnreadOnly(event.target.checked);
          }}
        />
        {t('notifications.unreadOnly')}
      </label>
      <FormError error={markOne.error ?? markAll.error} />
      {notifications.isPending ? (
        <ListSkeleton />
      ) : notifications.isError ? (
        <ErrorState
          error={notifications.error}
          onRetry={() => {
            void notifications.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <EmptyState message={unreadOnly ? t('notifications.emptyUnread') : t('notifications.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4',
                item.readAt === null && 'border-foreground/30',
              )}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className={cn(item.readAt === null && 'font-medium')}>
                  {notificationHref(item) === '/notifications' ? (
                    text(item.type, item.params)
                  ) : (
                    <Link href={notificationHref(item)} className="underline-offset-4 hover:underline">
                      {text(item.type, item.params)}
                    </Link>
                  )}
                </p>
                <p className="text-sm text-muted-foreground">
                  <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>
                </p>
              </div>
              {item.readAt === null ? (
                <div className="flex items-center gap-2">
                  <Badge>{t('notifications.unread')}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={markOne.isPending}
                    onClick={() => {
                      markOne.mutate(item.id);
                    }}
                  >
                    {t('notifications.markRead')}
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {notifications.hasNextPage ? (
        <Button
          variant="outline"
          className="mt-4"
          disabled={notifications.isFetchingNextPage}
          onClick={() => {
            void notifications.fetchNextPage();
          }}
        >
          {t('common.loadMore')}
        </Button>
      ) : null}
    </>
  );
}
