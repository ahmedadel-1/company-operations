'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import type { paths } from '@company-ops/api-client';
import { Badge } from '@company-ops/ui/components/badge';
import { Button } from '@company-ops/ui/components/button';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, NativeSelect } from '@company-ops/ui/components/input';

import { EmployeePicker } from '../../../components/employee-picker';
import type { PickedEmployee } from '../../../components/employee-picker';
import { Field, fieldErrorsOf, FormError } from '../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../components/states';
import { api, request } from '../../../lib/api';
import { useDepartments } from '../../../lib/queries';
import { useCan } from '../../../lib/session';

type Department = paths['/api/v1/departments/{id}']['get']['responses'][200]['content']['application/json']['data'];

/** Depth-first order so children follow their parent; returns each department with its depth. */
function asTree(departments: readonly Department[]): { department: Department; depth: number }[] {
  const ids = new Set(departments.map((department) => department.id));
  const children = new Map<string | null, Department[]>();
  for (const department of departments) {
    const parent =
      department.parentDepartmentId !== null && ids.has(department.parentDepartmentId)
        ? department.parentDepartmentId
        : null;
    children.set(parent, [...(children.get(parent) ?? []), department]);
  }
  const ordered: { department: Department; depth: number }[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const department of (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      ordered.push({ department, depth });
      visit(department.id, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

export default function DepartmentsPage() {
  const t = useTranslations();
  const can = useCan();
  const [showArchived, setShowArchived] = useState(false);
  const departments = useDepartments(showArchived);
  if (!can('employee.view')) {
    return <Forbidden />;
  }
  const manage = can('department.manage');

  return (
    <>
      <PageHeader
        title={t('departments.title')}
        actions={manage ? <DepartmentDialog departments={departments.data ?? []} /> : undefined}
      />
      <label className="mb-4 inline-flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => {
            setShowArchived(event.target.checked);
          }}
        />
        {t('departments.showArchived')}
      </label>
      {departments.isPending ? (
        <ListSkeleton />
      ) : departments.isError ? (
        <ErrorState
          error={departments.error}
          onRetry={() => {
            void departments.refetch();
          }}
        />
      ) : departments.data.length === 0 ? (
        <EmptyState message={t('departments.empty')} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t('departments.title')}>
          {asTree(departments.data).map(({ department, depth }) => (
            <li
              key={department.id}
              style={{ marginInlineStart: `${String(Math.min(depth, 6) * 1.5)}rem` }}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <p className="font-medium">
                  {department.name} <span className="text-sm text-muted-foreground">({department.code})</span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {t('departments.employees', { count: department.employeeCount })}
                  {department.manager === null ? '' : ` · ${t('departments.manager')}: ${department.manager.fullName}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {department.archived ? <Badge>{t('common.archived')}</Badge> : null}
                {manage ? (
                  <>
                    <DepartmentDialog departments={departments.data} department={department} />
                    <ArchiveButton department={department} />
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ArchiveButton({ department }: { readonly department: Department }) {
  const t = useTranslations('common');
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () =>
      department.archived
        ? request(() => api.POST('/api/v1/departments/{id}/unarchive', { params: { path: { id: department.id } } }))
        : request(() => api.POST('/api/v1/departments/{id}/archive', { params: { path: { id: department.id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['departments'] }),
  });
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={toggle.isPending}
        aria-label={`${department.archived ? t('unarchive') : t('archive')}: ${department.name}`}
        onClick={() => {
          toggle.mutate();
        }}
      >
        {department.archived ? t('unarchive') : t('archive')}
      </Button>
      <FormError error={toggle.error} />
    </>
  );
}

function DepartmentDialog({
  departments,
  department,
}: {
  readonly departments: readonly Department[];
  readonly department?: Department;
}) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(department?.name ?? '');
  const [code, setCode] = useState(department?.code ?? '');
  const [parentId, setParentId] = useState(department?.parentDepartmentId ?? '');
  const [manager, setManager] = useState<PickedEmployee | null>(department?.manager ?? null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        code: code.trim(),
        parentDepartmentId: parentId === '' ? null : parentId,
        managerId: manager?.id ?? null,
      };
      return department === undefined
        ? request(() => api.POST('/api/v1/departments', { body }))
        : request(() => api.PATCH('/api/v1/departments/{id}', { params: { path: { id: department.id } }, body }));
    },
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['departments'] });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };
  const title = department === undefined ? t('departments.new') : t('departments.edit');

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={department === undefined ? 'default' : 'outline'}
        size={department === undefined ? 'default' : 'sm'}
        aria-label={department === undefined ? undefined : `${t('common.edit')}: ${department.name}`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {department === undefined ? <PlusIcon aria-hidden="true" /> : null}
        {department === undefined ? t('departments.new') : t('common.edit')}
      </Button>
      <DialogContent title={title} closeLabel={t('common.close')}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <FormError error={save.error} />
          <Field label={t('departments.name')} errorCode={errors.get('name')}>
            {(control) => (
              <Input
                {...control}
                required
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('departments.code')} errorCode={errors.get('code')}>
            {(control) => (
              <Input
                {...control}
                required
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('departments.parent')} errorCode={errors.get('parentDepartmentId')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={parentId}
                onChange={(event) => {
                  setParentId(event.target.value);
                }}
              >
                <option value="">{t('departments.noParent')}</option>
                {departments
                  .filter((candidate) => candidate.id !== department?.id && !candidate.archived)
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
              </NativeSelect>
            )}
          </Field>
          <EmployeePicker label={t('departments.manager')} value={manager} onChange={setManager} allowNone />
          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
