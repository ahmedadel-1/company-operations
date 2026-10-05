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
import { Input } from '@company-ops/ui/components/input';

import { Field, fieldErrorsOf, FormError } from '../../../../components/form';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import { useJobTitles } from '../../../../lib/queries';
import { useCan } from '../../../../lib/session';

type JobTitle = paths['/api/v1/job-titles']['get']['responses'][200]['content']['application/json']['data'][number];

export default function JobTitlesPage() {
  const t = useTranslations();
  const can = useCan();
  const jobTitles = useJobTitles(true);
  if (!can('department.manage')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('jobTitles.title')} actions={<JobTitleDialog />} />
      {jobTitles.isPending ? (
        <ListSkeleton />
      ) : jobTitles.isError ? (
        <ErrorState
          error={jobTitles.error}
          onRetry={() => {
            void jobTitles.refetch();
          }}
        />
      ) : jobTitles.data.length === 0 ? (
        <EmptyState message={t('jobTitles.empty')} />
      ) : (
        <ul className="flex flex-col gap-2">
          {jobTitles.data.map((jobTitle) => (
            <li key={jobTitle.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <span className="flex items-center gap-2">
                {jobTitle.name}
                {jobTitle.archived ? <Badge>{t('common.archived')}</Badge> : null}
              </span>
              <span className="flex gap-2">
                <JobTitleDialog jobTitle={jobTitle} />
                <ArchiveJobTitle jobTitle={jobTitle} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ArchiveJobTitle({ jobTitle }: { readonly jobTitle: JobTitle }) {
  const t = useTranslations('common');
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: () =>
      request(() =>
        api.PATCH('/api/v1/job-titles/{id}', {
          params: { path: { id: jobTitle.id } },
          body: { archived: !jobTitle.archived },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['job-titles'] }),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={toggle.isPending}
      aria-label={`${jobTitle.archived ? t('unarchive') : t('archive')}: ${jobTitle.name}`}
      onClick={() => {
        toggle.mutate();
      }}
    >
      {jobTitle.archived ? t('unarchive') : t('archive')}
    </Button>
  );
}

function JobTitleDialog({ jobTitle }: { readonly jobTitle?: JobTitle }) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(jobTitle?.name ?? '');
  const save = useMutation({
    mutationFn: () =>
      jobTitle === undefined
        ? request(() => api.POST('/api/v1/job-titles', { body: { name: name.trim() } }))
        : request(() =>
            api.PATCH('/api/v1/job-titles/{id}', {
              params: { path: { id: jobTitle.id } },
              body: { name: name.trim() },
            }),
          ),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['job-titles'] });
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
        variant={jobTitle === undefined ? 'default' : 'outline'}
        size={jobTitle === undefined ? 'default' : 'sm'}
        aria-label={jobTitle === undefined ? undefined : `${t('common.edit')}: ${jobTitle.name}`}
        onClick={() => {
          setOpen(true);
        }}
      >
        {jobTitle === undefined ? <PlusIcon aria-hidden="true" /> : null}
        {jobTitle === undefined ? t('jobTitles.new') : t('common.edit')}
      </Button>
      <DialogContent
        title={jobTitle === undefined ? t('jobTitles.new') : t('jobTitles.rename')}
        closeLabel={t('common.close')}
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
          <FormError error={save.error} />
          <Field label={t('jobTitles.name')} errorCode={errors.get('name')}>
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
