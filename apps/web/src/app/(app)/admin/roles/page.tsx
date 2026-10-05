'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import type { paths } from '@company-ops/api-client';
import { PERMISSION_KEYS, SCOPES } from '@company-ops/shared';
import type { Scope } from '@company-ops/shared';
import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, Label, NativeSelect } from '@company-ops/ui/components/input';

import { Field, fieldErrorsOf, FormError } from '../../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request, requestEmpty } from '../../../../lib/api';
import { queryKeys, useRoles } from '../../../../lib/queries';
import { useCan } from '../../../../lib/session';

type Role = paths['/api/v1/roles']['get']['responses'][200]['content']['application/json']['data'][number];
type Grants = ReadonlyMap<string, readonly Scope[]>;

const ADMIN_ROLE_KEY = 'ORG_ADMIN';

/** Permission keys grouped by their module prefix, in catalog order. */
const GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ...PERMISSION_KEYS.reduce((groups, key) => {
    const group = key.split('.')[0] ?? key;
    groups.set(group, [...(groups.get(group) ?? []), key]);
    return groups;
  }, new Map<string, string[]>()),
];

/**
 * Roles (P9-8): system roles with editable grants and organization-specific custom roles. The API
 * enforces the escalation rules (ORG_ADMIN immutable, administrator-equivalent roles only for
 * organization admins, no edits to a role you hold); refusals are shown in the dialog.
 */
export default function RolesPage() {
  const t = useTranslations();
  const can = useCan();
  const roles = useRoles();
  if (!can('role.manage')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('roles.title')} description={t('roles.description')} actions={<RoleDialog />} />
      {roles.isPending ? (
        <ListSkeleton />
      ) : roles.isError ? (
        <ErrorState
          error={roles.error}
          onRetry={() => {
            void roles.refetch();
          }}
        />
      ) : roles.data.length === 0 ? (
        <EmptyState message={t('common.none')} />
      ) : (
        <ul className="flex flex-col gap-3">
          {roles.data.map((role) => (
            <li key={role.id} className="rounded-lg border p-4" data-testid="role-item">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium">{role.name}</h2>
                  {role.isSystem ? <Badge>{t('roles.system')}</Badge> : <Badge>{t('roles.custom')}</Badge>}
                  {role.administratorEquivalent ? (
                    <Badge tone="warning">{t('people.administratorEquivalent')}</Badge>
                  ) : null}
                </div>
                {role.key === ADMIN_ROLE_KEY ? (
                  <span className="text-xs text-muted-foreground">{t('roles.adminLocked')}</span>
                ) : (
                  <span className="flex gap-2">
                    <RoleDialog role={role} />
                    {role.isSystem ? null : <DeleteRole role={role} />}
                  </span>
                )}
              </div>
              <details className="mt-2 text-sm">
                <summary className="inline-flex min-h-11 cursor-pointer items-center text-muted-foreground">
                  {t('roles.showPermissions')} ({t('roles.permissions', { count: role.permissions.length })})
                </summary>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {role.permissions.map((permission) => (
                    <li
                      key={`${permission.key}:${permission.scope}`}
                      className="flex items-center justify-between gap-2 rounded bg-muted px-2 py-1"
                    >
                      <code className="text-xs">{permission.key}</code>
                      <span className="text-xs text-muted-foreground">{t(`roles.scopes.${permission.scope}`)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function grantsOf(role: Role | undefined): Grants {
  const grants = new Map<string, Scope[]>();
  for (const permission of role?.permissions ?? []) {
    grants.set(permission.key, [...(grants.get(permission.key) ?? []), permission.scope]);
  }
  return grants;
}

function RoleDialog({ role }: { readonly role?: Role }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(role?.name ?? '');
  const [grants, setGrants] = useState<Grants>(() => grantsOf(role));
  const permissions = [...grants].flatMap(([key, scopes]) => scopes.map((scope) => ({ key, scope })));
  const save = useMutation({
    mutationFn: () =>
      role === undefined
        ? request(() => api.POST('/api/v1/roles', { body: { name: name.trim(), permissions } }))
        : request(() =>
            api.PATCH('/api/v1/roles/{roleId}', {
              params: { path: { roleId: role.id } },
              body: role.isSystem ? { permissions } : { name: name.trim(), permissions },
            }),
          ),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.roles });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  const title = role === undefined ? t('roles.new') : `${t('common.edit')}: ${role.name}`;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setName(role?.name ?? '');
          setGrants(grantsOf(role));
          save.reset();
        }
      }}
    >
      <Button
        variant={role === undefined ? 'default' : 'outline'}
        size={role === undefined ? 'default' : 'sm'}
        aria-label={role === undefined ? undefined : `${t('common.edit')}: ${role.name}`}
        onClick={() => {
          setName(role?.name ?? '');
          setGrants(grantsOf(role));
          save.reset();
          setOpen(true);
        }}
      >
        {role === undefined ? <PlusIcon aria-hidden="true" /> : null}
        {role === undefined ? t('roles.new') : t('common.edit')}
      </Button>
      <DialogContent title={title} closeLabel={t('common.close')}>
        <form onSubmit={onSubmit} className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto" noValidate>
          <FormError error={save.error} />
          {role?.isSystem === true ? (
            <p className="text-sm text-muted-foreground">{t('roles.systemNameLocked')}</p>
          ) : (
            <Field label={t('roles.name')} errorCode={errors.get('name')}>
              {(control) => (
                <Input
                  {...control}
                  required
                  maxLength={80}
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                  }}
                />
              )}
            </Field>
          )}
          <p className="text-sm text-muted-foreground">{t('roles.grantsHint')}</p>
          {GROUPS.map(([group, keys]) => (
            <fieldset key={group} className="flex flex-col gap-2 rounded-md border p-3">
              <legend className="px-1 text-sm font-medium">{group}</legend>
              {keys.map((key) => {
                const id = `grant-${key.replace(/\./g, '-')}`;
                const scopes = grants.get(key) ?? [];
                return (
                  <div key={key} className="flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor={id} className="font-mono text-xs">
                      {key}
                    </Label>
                    <NativeSelect
                      id={id}
                      className="w-40"
                      value={scopes[0] ?? ''}
                      onChange={(event) => {
                        const next = new Map(grants);
                        const scope = SCOPES.find((candidate) => candidate === event.target.value);
                        if (scope === undefined) {
                          next.delete(key);
                        } else {
                          next.set(key, [scope]);
                        }
                        setGrants(next);
                      }}
                    >
                      <option value="">{t('roles.notGranted')}</option>
                      {SCOPES.map((scope) => (
                        <option key={scope} value={scope}>
                          {t(`roles.scopes.${scope}`)}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                );
              })}
            </fieldset>
          ))}
          <div className="sticky bottom-0 flex justify-end bg-background pt-2">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRole({ role }: { readonly role: Role }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () =>
      requestEmpty(() => api.DELETE('/api/v1/roles/{roleId}', { params: { path: { roleId: role.id } } })),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.roles });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        remove.reset();
      }}
    >
      <Button
        variant="destructive"
        size="sm"
        aria-label={`${t('roles.delete')}: ${role.name}`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('roles.delete')}
      </Button>
      {open ? (
        <DialogContent title={t('roles.deleteTitle', { name: role.name })} closeLabel={t('common.close')}>
          <div className="flex flex-col gap-4 text-sm">
            <p>{t('roles.deleteBody')}</p>
            <FormError error={remove.error} />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate();
                }}
              >
                {t('roles.deleteConfirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
