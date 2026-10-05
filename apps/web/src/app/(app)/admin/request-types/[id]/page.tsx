'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Input, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { Field, fieldErrorsOf, FormError, StatusMessage } from '../../../../../components/form';
import { ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../../components/states';
import { WorkflowBuilder } from '../../../../../components/workflow-builder';
import { api, request } from '../../../../../lib/api';
import { useDateFormat } from '../../../../../lib/format';
import { useRoles } from '../../../../../lib/queries';
import {
  REQUEST_CATEGORIES,
  REQUEST_TYPE_ICONS,
  requestKeys,
  useAdminRequestType,
  useLocalized,
  useWorkflowVersion,
  useWorkflowVersions,
} from '../../../../../lib/requests';
import type {
  AdminRequestType,
  RequestCategory,
  RequestTypeIcon,
  WorkflowVersionSummary,
} from '../../../../../lib/requests';
import { useCanOrgWide } from '../../../../../lib/session';

const VERSION_TONES: Readonly<Record<WorkflowVersionSummary['status'], 'neutral' | 'success' | 'warning'>> = {
  DRAFT: 'warning',
  PUBLISHED: 'success',
  RETIRED: 'neutral',
};

export default function RequestTypeAdminPage() {
  const orgWide = useCanOrgWide();
  const params = useParams<{ id: string }>();
  if (!orgWide('request.admin')) {
    return <Forbidden />;
  }
  return <TypeAdmin id={params.id} />;
}

function TypeAdmin({ id }: { readonly id: string }) {
  const t = useTranslations();
  const localized = useLocalized();
  const type = useAdminRequestType(id);
  const [selected, setSelected] = useState<string | null>(null);
  if (type.isPending) return <ListSkeleton />;
  if (type.isError) {
    return (
      <ErrorState
        error={type.error}
        onRetry={() => {
          void type.refetch();
        }}
      />
    );
  }
  const data = type.data;
  const versionId = selected ?? data.draftVersion?.id ?? data.publishedVersion?.id ?? null;
  return (
    <>
      <PageHeader
        title={localized(data.name)}
        description={`${data.key} · ${t(`requests.categories.${data.category}`)}`}
        actions={
          <Button variant="outline" asChild>
            <Link href="/admin/request-types">{t('requestAdmin.backToList')}</Link>
          </Button>
        }
      />
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 xl:col-span-2">
          {versionId === null ? null : <VersionPanel typeId={id} versionId={versionId} />}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Versions type={data} selected={versionId} onSelect={setSelected} />
          <TypeSettings key={data.version} type={data} />
        </div>
      </div>
    </>
  );
}

function VersionPanel({ typeId, versionId }: { readonly typeId: string; readonly versionId: string }) {
  const version = useWorkflowVersion(typeId, versionId);
  if (version.isPending) return <ListSkeleton rows={4} />;
  if (version.isError) {
    return (
      <ErrorState
        error={version.error}
        onRetry={() => {
          void version.refetch();
        }}
      />
    );
  }
  const memberNames: Record<string, string> = {};
  for (const step of version.data.steps) {
    if (step.approver?.member) memberNames[step.approver.member.memberId] = step.approver.member.name;
  }
  return <WorkflowBuilder key={version.data.id} typeId={typeId} version={version.data} memberNames={memberNames} />;
}

function Versions({
  type,
  selected,
  onSelect,
}: {
  readonly type: AdminRequestType;
  readonly selected: string | null;
  readonly onSelect: (id: string | null) => void;
}) {
  const t = useTranslations();
  const { dateTime } = useDateFormat();
  const queryClient = useQueryClient();
  const versions = useWorkflowVersions(type.id);
  const rows = versions.data?.pages.flatMap((page) => page.data) ?? [];
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: requestKeys.adminType(type.id) }),
      queryClient.invalidateQueries({ queryKey: requestKeys.versions(type.id) }),
      queryClient.invalidateQueries({ queryKey: requestKeys.adminTypes }),
    ]);
  const createDraft = useMutation({
    mutationFn: async () =>
      (
        await request(() =>
          api.POST('/api/v1/request-admin/types/{id}/versions', { params: { path: { id: type.id } } }),
        )
      ).data,
    onSuccess: async (draft) => {
      queryClient.setQueryData(requestKeys.version(type.id, draft.id), draft);
      onSelect(draft.id);
      await invalidate();
    },
  });
  const discard = useMutation({
    mutationFn: async () => {
      const draft = type.draftVersion;
      if (draft === null) return;
      await request(() =>
        api.POST('/api/v1/request-admin/types/{id}/versions/{versionId}/discard', {
          params: { path: { id: type.id, versionId: draft.id } },
          body: { revision: draft.revision },
        }),
      );
    },
    onSuccess: async () => {
      onSelect(null);
      await invalidate();
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('requestAdmin.versions')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <FormError error={createDraft.error ?? discard.error} />
        {type.draftVersion === null ? (
          <Button
            data-testid="new-version"
            disabled={createDraft.isPending}
            onClick={() => {
              createDraft.mutate();
            }}
          >
            {createDraft.isPending ? t('common.saving') : t('requestAdmin.newVersion')}
          </Button>
        ) : (
          <Button
            variant="outline"
            data-testid="discard-version"
            disabled={discard.isPending}
            onClick={() => {
              if (window.confirm(t('requestAdmin.confirmDiscard'))) discard.mutate();
            }}
          >
            {t('requestAdmin.discardDraft')}
          </Button>
        )}
        {versions.isPending ? (
          <ListSkeleton rows={2} />
        ) : versions.isError ? (
          <ErrorState
            error={versions.error}
            onRetry={() => {
              void versions.refetch();
            }}
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="version-list">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={row.id === selected ? 'true' : undefined}
                  data-testid="version-item"
                  data-status={row.status}
                  data-number={row.number}
                  className="flex w-full flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-start hover:bg-muted aria-[current=true]:border-primary aria-[current=true]:bg-muted"
                  onClick={() => {
                    onSelect(row.id);
                  }}
                >
                  <span className="font-medium">{t('requestAdmin.versionNumber', { number: row.number })}</span>
                  <Badge tone={VERSION_TONES[row.status]}>{t(`requestAdmin.versionStatuses.${row.status}`)}</Badge>
                  <span className="w-full text-xs text-muted-foreground">
                    {row.publishedAt === null
                      ? t('requestAdmin.createdAt', { date: dateTime(row.createdAt) })
                      : t('requestAdmin.publishedAt', { date: dateTime(row.publishedAt) })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {versions.hasNextPage ? (
          <Button
            variant="outline"
            disabled={versions.isFetchingNextPage}
            onClick={() => {
              void versions.fetchNextPage();
            }}
          >
            {t('common.loadMore')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function TypeSettings({ type }: { readonly type: AdminRequestType }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const roles = useRoles();
  const [form, setForm] = useState({
    nameEn: type.name.en,
    nameAr: type.name.ar ?? '',
    descriptionEn: type.description?.en ?? '',
    descriptionAr: type.description?.ar ?? '',
    category: type.category,
    icon: type.icon,
    requesterRoleIds: type.requesterRoles.map((role) => role.id),
  });
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: async (active?: boolean) =>
      (
        await request(() =>
          api.PATCH('/api/v1/request-admin/types/{id}', {
            params: { path: { id: type.id } },
            body:
              active === undefined
                ? {
                    version: type.version,
                    name: { en: form.nameEn.trim(), ...(form.nameAr.trim() === '' ? {} : { ar: form.nameAr.trim() }) },
                    description:
                      form.descriptionEn.trim() === ''
                        ? null
                        : {
                            en: form.descriptionEn.trim(),
                            ...(form.descriptionAr.trim() === '' ? {} : { ar: form.descriptionAr.trim() }),
                          },
                    category: form.category,
                    icon: form.icon,
                    requesterRoleIds: form.requesterRoleIds,
                  }
                : { version: type.version, active },
          }),
        )
      ).data,
    onSuccess: async (updated) => {
      setSaved(true);
      queryClient.setQueryData(requestKeys.adminType(type.id), updated);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: requestKeys.adminTypes }),
        queryClient.invalidateQueries({ queryKey: requestKeys.catalog }),
      ]);
    },
  });
  const errors = fieldErrorsOf(save.error);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaved(false);
    save.mutate(undefined);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('requestAdmin.settings')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4" data-testid="request-type-settings">
          <FormError error={save.error} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge tone={type.active ? 'success' : 'neutral'}>
              {type.active ? t('requestAdmin.active') : t('requestAdmin.inactive')}
            </Badge>
            <Button
              type="button"
              size="sm"
              variant={type.active ? 'outline' : 'default'}
              data-testid="toggle-active"
              disabled={save.isPending || (!type.active && type.publishedVersion === null)}
              onClick={() => {
                setSaved(false);
                save.mutate(!type.active);
              }}
            >
              {type.active ? t('requestAdmin.deactivate') : t('requestAdmin.activate')}
            </Button>
          </div>
          {!type.active && type.publishedVersion === null ? (
            <p className="text-sm text-muted-foreground">{t('requestAdmin.activateHint')}</p>
          ) : null}
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
          <Field
            label={`${t('requestAdmin.typeDescription')} (${t('requestAdmin.english')})`}
            optional
            errorCode={errors.get('description')}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={1000}
                value={form.descriptionEn}
                onChange={(event) => {
                  setForm({ ...form, descriptionEn: event.target.value });
                }}
              />
            )}
          </Field>
          <Field label={`${t('requestAdmin.typeDescription')} (${t('requestAdmin.arabic')})`} optional>
            {(control) => (
              <Textarea
                {...control}
                dir="rtl"
                rows={2}
                maxLength={1000}
                value={form.descriptionAr}
                onChange={(event) => {
                  setForm({ ...form, descriptionAr: event.target.value });
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
                  const category: RequestCategory | undefined = REQUEST_CATEGORIES.find(
                    (value) => value === event.target.value,
                  );
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
                  const icon: RequestTypeIcon | undefined = REQUEST_TYPE_ICONS.find(
                    (value) => value === event.target.value,
                  );
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
          <fieldset className="flex flex-col gap-2" aria-describedby="requester-roles-hint">
            <legend className="text-sm font-medium">{t('requestAdmin.requesterRoles')}</legend>
            <p id="requester-roles-hint" className="text-xs text-muted-foreground">
              {t('requestAdmin.requesterRolesHint')}
            </p>
            {(roles.data ?? []).map((role) => (
              <label key={role.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={form.requesterRoleIds.includes(role.id)}
                  onChange={(event) => {
                    setForm({
                      ...form,
                      requesterRoleIds: event.target.checked
                        ? [...form.requesterRoleIds, role.id]
                        : form.requesterRoleIds.filter((value) => value !== role.id),
                    });
                  }}
                />
                {role.name}
              </label>
            ))}
          </fieldset>
          <Button type="submit" disabled={save.isPending || form.nameEn.trim() === ''}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
          {saved && !save.isPending && save.isSuccess ? (
            <StatusMessage>{t('requestAdmin.settingsSaved')}</StatusMessage>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
