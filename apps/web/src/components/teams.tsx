'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SubmitEvent } from 'react';

import type { paths } from '@company-ops/api-client';
import { Button } from '@company-ops/ui/components/button';
import { Dialog, DialogContent } from '@company-ops/ui/components/dialog';
import { Input, NativeSelect } from '@company-ops/ui/components/input';

import { api, request } from '../lib/api';
import { useDepartments } from '../lib/queries';
import { EmployeePicker } from './employee-picker';
import type { PickedEmployee } from './employee-picker';
import { Field, fieldErrorsOf, FormError } from './form';

export type Team = paths['/api/v1/teams/{id}']['get']['responses'][200]['content']['application/json']['data'];

export function TeamDialog({ team }: { readonly team?: Team }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const departments = useDepartments();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team?.name ?? '');
  const [departmentId, setDepartmentId] = useState(team?.department?.id ?? '');
  const [lead, setLead] = useState<PickedEmployee | null>(team?.lead ?? null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        departmentId: departmentId === '' ? null : departmentId,
        leadId: lead?.id ?? null,
      };
      return team === undefined
        ? request(() => api.POST('/api/v1/teams', { body }))
        : request(() => api.PATCH('/api/v1/teams/{id}', { params: { path: { id: team.id } }, body }));
    },
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['teams'] });
    },
  });
  const errors = fieldErrorsOf(save.error);
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={team === undefined ? 'default' : 'outline'}
        onClick={() => {
          setOpen(true);
        }}
      >
        {team === undefined ? <PlusIcon aria-hidden="true" /> : null}
        {team === undefined ? t('teams.new') : t('common.edit')}
      </Button>
      <DialogContent title={team === undefined ? t('teams.new') : t('teams.edit')} closeLabel={t('common.close')}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <FormError error={save.error} />
          <Field label={t('teams.name')} errorCode={errors.get('name')}>
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
          <Field label={t('teams.department')} errorCode={errors.get('departmentId')}>
            {(control) => (
              <NativeSelect
                {...control}
                value={departmentId}
                onChange={(event) => {
                  setDepartmentId(event.target.value);
                }}
              >
                <option value="">{t('teams.noDepartment')}</option>
                {(departments.data ?? []).map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <EmployeePicker label={t('teams.lead')} value={lead} onChange={setLead} allowNone />
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
