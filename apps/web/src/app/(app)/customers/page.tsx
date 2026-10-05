'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card } from '@company-ops/ui/components/card';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, NativeSelect, Textarea } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { Field, fieldErrorsOf, FormError } from '../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { api, request } from '../../../lib/api';
import { useCustomers } from '../../../lib/projects';
import type { Customer } from '../../../lib/projects';
import { useCan, useCanOrgWide } from '../../../lib/session';

const CUSTOMER_TYPES = ['GOVERNMENT', 'PRIVATE', 'INTERNAL'] as const;

export default function CustomersPage() {
  const t = useTranslations();
  const can = useCan();
  const orgWide = useCanOrgWide();
  const [includeArchived, setIncludeArchived] = useState(false);
  const readable = can('project.create') || can('project.manage') || orgWide('project.view');
  const manage = orgWide('project.create');
  const customers = useCustomers({ includeArchived, enabled: readable });
  if (!readable) {
    return <Forbidden />;
  }
  const rows = customers.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <PageHeader
        title={t('customers.title')}
        description={t('customers.description')}
        actions={manage ? <CustomerDialog /> : undefined}
      />
      <label className="mb-4 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeArchived}
          onChange={(event) => {
            setIncludeArchived(event.target.checked);
          }}
        />
        {t('customers.showArchived')}
      </label>
      {customers.isPending ? (
        <ListSkeleton />
      ) : customers.isError ? (
        <ErrorState
          error={customers.error}
          onRetry={() => {
            void customers.refetch();
          }}
        />
      ) : rows.length === 0 ? (
        <EmptyState message={t('customers.empty')} />
      ) : (
        <>
          <Card className="hidden md:block">
            <Table>
              <thead>
                <TableRow>
                  <TableHead>{t('customers.name')}</TableHead>
                  <TableHead>{t('customers.type')}</TableHead>
                  <TableHead>{t('customers.contact')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('common.actions')}</span>
                  </TableHead>
                </TableRow>
              </thead>
              <tbody>
                {rows.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell className="font-medium">
                      {customer.name} {customer.archived ? <Badge>{t('common.archived')}</Badge> : null}
                    </TableCell>
                    <TableCell>{t(`customers.types.${customer.type}`)}</TableCell>
                    <TableCell>
                      {[customer.contactName, customer.contactEmail].filter(Boolean).join(' · ') || t('common.none')}
                    </TableCell>
                    <TableCell className="text-end">{manage ? <CustomerDialog customer={customer} /> : null}</TableCell>
                  </TableRow>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="flex flex-col gap-3 md:hidden">
            {rows.map((customer) => (
              <li key={customer.id} className="flex flex-col gap-2 rounded-lg border p-4">
                <span className="font-medium">
                  {customer.name} {customer.archived ? <Badge>{t('common.archived')}</Badge> : null}
                </span>
                <span className="text-sm text-muted-foreground">{t(`customers.types.${customer.type}`)}</span>
                {manage ? <CustomerDialog customer={customer} /> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function CustomerDialog({ customer }: { readonly customer?: Customer }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: customer?.name ?? '',
    type: customer?.type ?? 'PRIVATE',
    contactName: customer?.contactName ?? '',
    contactEmail: customer?.contactEmail ?? '',
    notes: customer?.notes ?? '',
    archived: customer?.archived ?? false,
  });
  const save = useMutation({
    mutationFn: async () => {
      const type = CUSTOMER_TYPES.find((value) => value === draft.type) ?? 'PRIVATE';
      const body = {
        name: draft.name.trim(),
        type,
        contactName: draft.contactName.trim() === '' ? null : draft.contactName.trim(),
        contactEmail: draft.contactEmail.trim() === '' ? null : draft.contactEmail.trim(),
        notes: draft.notes.trim() === '' ? null : draft.notes.trim(),
      };
      return customer === undefined
        ? request(() => api.POST('/api/v1/customers', { body }))
        : request(() =>
            api.PATCH('/api/v1/customers/{id}', {
              params: { path: { id: customer.id } },
              body: { ...body, archived: draft.archived },
            }),
          );
    },
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  const title = customer === undefined ? t('customers.new') : t('customers.edit');
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={customer === undefined ? 'default' : 'outline'}
        size={customer === undefined ? 'default' : 'sm'}
        onClick={() => {
          setOpen(true);
        }}
      >
        {customer === undefined ? <PlusIcon aria-hidden="true" /> : null}
        {customer === undefined ? title : t('common.edit')}
        {customer === undefined ? null : <span className="sr-only">{customer.name}</span>}
      </Button>
      <DialogContent title={title} closeLabel={t('common.close')}>
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <FormError error={save.error} />
          <Field label={t('customers.name')} errorCode={errors.get('name')}>
            {(control) => (
              <Input
                {...control}
                required
                maxLength={200}
                value={draft.name}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('customers.type')} errorCode={errors.get('type')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={draft.type}
                onChange={(event) => {
                  const type = CUSTOMER_TYPES.find((value) => value === event.target.value);
                  if (type !== undefined) {
                    setDraft({ ...draft, type });
                  }
                }}
              >
                {CUSTOMER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`customers.types.${type}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label={t('customers.contactName')} errorCode={errors.get('contactName')} optional>
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                value={draft.contactName}
                onChange={(event) => {
                  setDraft({ ...draft, contactName: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('customers.contactEmail')} errorCode={errors.get('contactEmail')} optional>
            {(control) => (
              <Input
                {...control}
                type="email"
                maxLength={254}
                value={draft.contactEmail}
                onChange={(event) => {
                  setDraft({ ...draft, contactEmail: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('customers.notes')} errorCode={errors.get('notes')} optional>
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={draft.notes}
                onChange={(event) => {
                  setDraft({ ...draft, notes: event.target.value });
                }}
              />
            )}
          </Field>
          {customer === undefined ? null : (
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.archived}
                onChange={(event) => {
                  setDraft({ ...draft, archived: event.target.checked });
                }}
              />
              {t('common.archived')}
            </label>
          )}
          <Button type="submit" className="self-end" disabled={save.isPending || draft.name.trim() === ''}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
