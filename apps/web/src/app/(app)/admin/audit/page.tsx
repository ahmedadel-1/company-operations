'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import type { paths } from '@company-ops/api-client';
import { Button } from '@company-ops/ui/components/button';
import { Card } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { DetailList } from '../../../../components/people';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { useDateFormat } from '../../../../lib/format';
import { useAuditEvents } from '../../../../lib/queries';
import type { AuditFilters } from '../../../../lib/queries';
import { useCan } from '../../../../lib/session';

type AuditEvent = paths['/api/v1/audit/events/{id}']['get']['responses'][200]['content']['application/json']['data'];

/** `datetime-local` value (no zone) → ISO instant in the browser's zone; empty → undefined. */
function toInstant(value: string): string | undefined {
  if (value === '') {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export default function AuditPage() {
  const t = useTranslations();
  const can = useCan();
  if (!can('audit.view')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('audit.title')} />
      <AuditLog />
    </>
  );
}

function AuditLog() {
  const t = useTranslations();
  const { dateTime } = useDateFormat();
  const [draft, setDraft] = useState({ action: '', entityType: '', from: '', to: '' });
  const [filters, setFilters] = useState<AuditFilters>({});
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const events = useAuditEvents(filters);
  const rows = events.data?.pages.flatMap((page) => page.data) ?? [];

  const apply = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const action = draft.action.trim();
    const from = toInstant(draft.from);
    const to = toInstant(draft.to);
    setFilters({
      // A trailing dot or a partial name searches by prefix (e.g. "role.").
      ...(action === '' ? {} : action.endsWith('.') ? { actionPrefix: action.slice(0, -1) } : { action }),
      ...(draft.entityType.trim() === '' ? {} : { entityType: draft.entityType.trim() }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={apply}
        role="search"
        className="grid gap-3 rounded-lg border p-4 md:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-action">{t('audit.action')}</Label>
          <Input
            id="audit-action"
            placeholder={t('audit.actionPlaceholder')}
            value={draft.action}
            onChange={(event) => {
              setDraft({ ...draft, action: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-entity">{t('audit.entityType')}</Label>
          <Input
            id="audit-entity"
            value={draft.entityType}
            onChange={(event) => {
              setDraft({ ...draft, entityType: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-from">{t('audit.from')}</Label>
          <Input
            id="audit-from"
            type="datetime-local"
            value={draft.from}
            onChange={(event) => {
              setDraft({ ...draft, from: event.target.value });
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="audit-to">{t('audit.to')}</Label>
          <Input
            id="audit-to"
            type="datetime-local"
            value={draft.to}
            onChange={(event) => {
              setDraft({ ...draft, to: event.target.value });
            }}
          />
        </div>
        <Button type="submit" variant="outline">
          {t('common.apply')}
        </Button>
      </form>

      {events.isPending ? (
        <ListSkeleton />
      ) : events.isError ? (
        <ErrorState
          error={events.error}
          onRetry={() => {
            void events.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={t('audit.empty')} />
      ) : (
        <>
          <Card className="hidden md:block">
            <Table>
              <thead>
                <TableRow>
                  <TableHead>{t('audit.time')}</TableHead>
                  <TableHead>{t('audit.action')}</TableHead>
                  <TableHead>{t('audit.entity')}</TableHead>
                  <TableHead>{t('audit.actor')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                </TableRow>
              </thead>
              <tbody>
                {rows.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap">
                      <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
                    </TableCell>
                    <TableCell>
                      <code className="text-xs">{event.action}</code>
                    </TableCell>
                    <TableCell className="text-sm">{event.entityType}</TableCell>
                    <TableCell>{event.actor.displayName ?? t(`audit.actorTypes.${event.actorType}`)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelected(event);
                        }}
                      >
                        {t('audit.view')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="flex flex-col gap-3 md:hidden">
            {rows.map((event) => (
              <li key={event.id}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-1 rounded-lg border p-4 text-start hover:bg-accent"
                  onClick={() => {
                    setSelected(event);
                  }}
                >
                  <code className="text-xs">{event.action}</code>
                  <span className="text-sm text-muted-foreground">
                    {dateTime(event.createdAt)} · {event.actor.displayName ?? t(`audit.actorTypes.${event.actorType}`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {events.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              disabled={events.isFetchingNextPage}
              onClick={() => {
                void events.fetchNextPage();
              }}
            >
              {t('common.loadMore')}
            </Button>
          ) : null}
        </>
      )}

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
          }
        }}
      >
        {selected === null ? null : (
          <DialogContent title={t('audit.detailTitle')} closeLabel={t('common.close')}>
            <DetailList
              items={[
                [t('audit.time'), dateTime(selected.createdAt)],
                [t('audit.action'), selected.action],
                [
                  t('audit.entity'),
                  `${selected.entityType}${selected.entityId === null ? '' : ` · ${selected.entityId}`}`,
                ],
                [t('audit.actor'), selected.actor.displayName ?? t(`audit.actorTypes.${selected.actorType}`)],
                [t('audit.ip'), selected.ip],
                [t('audit.userAgent'), selected.userAgent],
                [t('common.requestId'), selected.requestId],
              ]}
            />
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">{t('audit.metadata')}</p>
              <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs" dir="ltr">
                {JSON.stringify(selected.metadata, null, 2)}
              </pre>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
