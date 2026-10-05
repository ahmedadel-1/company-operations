'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Input, NativeSelect } from '@company-ops/ui/components/input';
import { Table, TableCell, TableHead, TableRow } from '@company-ops/ui/components/table';

import { Field, fieldErrorsOf, FormError } from '../../../../components/form';
import { RequestTypeIconView } from '../../../../components/requests';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import {
  REQUEST_CATEGORIES,
  REQUEST_TYPE_ICONS,
  requestKeys,
  useAdminRequestTypes,
  useLocalized,
} from '../../../../lib/requests';
import type { RequestCategory, RequestTypeIcon } from '../../../../lib/requests';
import { useCanOrgWide } from '../../../../lib/session';

export default function RequestTypesAdminPage() {
  const t = useTranslations();
  const orgWide = useCanOrgWide();
  const allowed = orgWide('request.admin');
  const types = useAdminRequestTypes(allowed);
  const localized = useLocalized();
  if (!allowed) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('requestAdmin.title')} description={t('requestAdmin.description')} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          {types.isPending ? (
            <ListSkeleton />
          ) : types.isError ? (
            <ErrorState
              error={types.error}
              onRetry={() => {
                void types.refetch();
              }}
            />
          ) : types.data.length === 0 ? (
            <EmptyState message={t('requestAdmin.empty')} />
          ) : (
            <Card>
              <Table aria-label={t('requestAdmin.title')}>
                <thead>
                  <TableRow>
                    <TableHead>{t('requestAdmin.name')}</TableHead>
                    <TableHead>{t('requestAdmin.state')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('requestAdmin.published')}</TableHead>
                  </TableRow>
                </thead>
                <tbody>
                  {types.data.map((type) => (
                    <TableRow key={type.id} data-testid="request-type-row" data-key={type.key}>
                      <TableCell>
                        <Link
                          href={`/admin/request-types/${type.id}`}
                          className="flex items-center gap-2 font-medium underline-offset-4 hover:underline"
                        >
                          <RequestTypeIconView icon={type.icon} className="size-4 shrink-0 text-muted-foreground" />
                          {localized(type.name)}
                        </Link>
                        <span className="text-xs text-muted-foreground">
                          {type.key} · {t(`requests.categories.${type.category}`)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={type.active ? 'success' : 'neutral'}>
                            {type.active ? t('requestAdmin.active') : t('requestAdmin.inactive')}
                          </Badge>
                          {type.draftVersion === null ? null : (
                            <Badge tone="warning">
                              {t('requestAdmin.draftPending', { number: type.draftVersion.number })}
                            </Badge>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {type.publishedVersion === null
                          ? t('requestAdmin.notPublished')
                          : t('requestAdmin.versionNumber', { number: type.publishedVersion.number })}
                      </TableCell>
                    </TableRow>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
        <CreateType />
      </div>
    </>
  );
}

function CreateType() {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{
    key: string;
    nameEn: string;
    nameAr: string;
    category: RequestCategory;
    icon: RequestTypeIcon;
  }>({ key: '', nameEn: '', nameAr: '', category: 'HR', icon: 'file-text' });
  const create = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.POST('/api/v1/request-admin/types', {
            body: {
              key: form.key.trim(),
              name: { en: form.nameEn.trim(), ...(form.nameAr.trim() === '' ? {} : { ar: form.nameAr.trim() }) },
              category: form.category,
              icon: form.icon,
            },
          }),
        )
      ).data,
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: requestKeys.adminTypes });
      router.push(`/admin/request-types/${created.id}`);
    },
  });
  const errors = fieldErrorsOf(create.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('requestAdmin.create')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4" data-testid="create-request-type">
          <FormError error={create.error} />
          <Field label={t('requestAdmin.key')} hint={t('requestAdmin.keyHint')} errorCode={errors.get('key')}>
            {(control) => (
              <Input
                {...control}
                required
                maxLength={50}
                value={form.key}
                onChange={(event) => {
                  setForm({ ...form, key: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={`${t('requestAdmin.name')} (${t('requestAdmin.english')})`} errorCode={errors.get('name')}>
            {(control) => (
              <Input
                {...control}
                required
                maxLength={200}
                value={form.nameEn}
                onChange={(event) => {
                  setForm({ ...form, nameEn: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={`${t('requestAdmin.name')} (${t('requestAdmin.arabic')})`} optional>
            {(control) => (
              <Input
                {...control}
                dir="rtl"
                maxLength={200}
                value={form.nameAr}
                onChange={(event) => {
                  setForm({ ...form, nameAr: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={t('requestAdmin.category')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={form.category}
                onChange={(event) => {
                  const category = REQUEST_CATEGORIES.find((value) => value === event.target.value);
                  if (category !== undefined) setForm({ ...form, category });
                }}
              >
                {REQUEST_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {t(`requests.categories.${category}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Field label={t('requestAdmin.icon')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={form.icon}
                onChange={(event) => {
                  const icon = REQUEST_TYPE_ICONS.find((value) => value === event.target.value);
                  if (icon !== undefined) setForm({ ...form, icon });
                }}
              >
                {REQUEST_TYPE_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {t(`requestAdmin.icons.${icon}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Button type="submit" disabled={create.isPending || form.key.trim() === '' || form.nameEn.trim() === ''}>
            {create.isPending ? t('common.saving') : t('requestAdmin.createSubmit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
