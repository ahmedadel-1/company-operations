'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PaperclipIcon, XIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ChangeEvent, SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Input, Label, NativeSelect, Textarea } from '@company-ops/ui/components/input';

import { Field, fieldErrorsOf, FormError } from '../../../../components/form';
import { ATTACHMENT_MAX_BYTES, TICKET_ATTACHMENT_TYPES } from '../../../../components/report-attachments';
import { Forbidden, PageHeader } from '../../../../components/states';
import { api, request } from '../../../../lib/api';
import { useProjects } from '../../../../lib/projects';
import { useCan } from '../../../../lib/session';
import { uploadAttachment } from '../../../../lib/uploads';
import type { UploadCallbacks } from '../../../../lib/uploads';
import {
  supportKeys,
  TICKET_IMPACTS,
  TICKET_PRIORITIES,
  TICKET_SEVERITIES,
  TICKET_SOURCES,
  useSupportCategories,
  useSupportComponents,
} from '../../../../lib/support';
import type { TicketImpact, TicketPriority, TicketSeverity, TicketSource } from '../../../../lib/support';

interface TicketDraft {
  readonly title: string;
  readonly description: string;
  readonly severity: TicketSeverity;
  readonly impact: TicketImpact;
  readonly source: TicketSource;
  readonly priority: TicketPriority | '';
  readonly projectId: string;
  readonly categoryId: string;
  readonly componentId: string;
}

const ALLOWED_TYPES: readonly string[] = TICKET_ATTACHMENT_TYPES;
const NO_PROGRESS: UploadCallbacks = { onProgress: () => undefined, onVerifying: () => undefined };

function initialProjectId(): string {
  const value = new URLSearchParams(window.location.search).get('projectId') ?? '';
  return /^[0-9a-f-]{36}$/i.test(value) ? value : '';
}

export default function NewTicketPage() {
  const t = useTranslations();
  const can = useCan();
  if (!can('support.create')) {
    return <Forbidden />;
  }
  return (
    <>
      <PageHeader title={t('support.create.title')} description={t('support.create.intro')} />
      <NewTicketForm />
    </>
  );
}

function NewTicketForm() {
  const t = useTranslations();
  const can = useCan();
  const router = useRouter();
  const queryClient = useQueryClient();
  const readsProjects = can('project.view');
  const setsPriority = can('support.triage');
  // One key per form instance: a retried or double-submitted request creates the ticket only once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState<TicketDraft>(() => ({
    title: '',
    description: '',
    severity: 'MEDIUM',
    impact: 'SINGLE_USER',
    source: can('daily_report.submit') ? 'FIELD' : 'INTERNAL',
    priority: '',
    projectId: initialProjectId(),
    categoryId: '',
    componentId: '',
  }));
  const projects = useProjects({}, readsProjects);
  const categories = useSupportCategories();
  const components = useSupportComponents({ projectId: form.projectId === '' ? null : form.projectId });

  const fileInputId = useId();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ readonly current: number; readonly total: number } | null>(null);
  const [partial, setPartial] = useState<{ readonly id: string; readonly key: string; readonly names: string } | null>(
    null,
  );

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    if (chosen.some((file) => !ALLOWED_TYPES.includes(file.type))) {
      setFileError(t('support.attachments.badType'));
      return;
    }
    if (chosen.some((file) => file.size > ATTACHMENT_MAX_BYTES)) {
      setFileError(t('support.attachments.tooLarge'));
      return;
    }
    setFileError(null);
    setFiles([...files, ...chosen]);
  };

  const create = useMutation({
    mutationFn: async () => {
      const ticket = (
        await request(() =>
          api.POST('/api/v1/support/tickets', {
            params: { header: { 'Idempotency-Key': idempotencyKey } },
            body: {
              title: form.title.trim(),
              description: form.description.trim(),
              severity: form.severity,
              impact: form.impact,
              source: form.source,
              ...(form.priority === '' ? {} : { priority: form.priority }),
              ...(form.projectId === '' ? {} : { projectId: form.projectId }),
              ...(form.categoryId === '' ? {} : { categoryId: form.categoryId }),
              ...(form.componentId === '' ? {} : { componentId: form.componentId }),
            },
          }),
        )
      ).data;
      const failed: string[] = [];
      for (const [index, file] of files.entries()) {
        setProgress({ current: index + 1, total: files.length });
        const attached = await uploadAttachment('SUPPORT_TICKET', ticket.id, file, NO_PROGRESS).then(
          (id) => id !== null,
          () => false,
        );
        if (!attached) {
          failed.push(file.name);
        }
      }
      return { ticket, failed };
    },
    onSettled: () => {
      setProgress(null);
    },
    onSuccess: async ({ ticket, failed }) => {
      queryClient.setQueryData(supportKeys.ticket(ticket.id), ticket);
      await queryClient.invalidateQueries({ queryKey: ['support', 'tickets'] });
      if (failed.length === 0) {
        router.push(`/support/tickets/${ticket.id}`);
      } else {
        setPartial({ id: ticket.id, key: ticket.key, names: failed.join(', ') });
      }
    },
  });
  const errors = fieldErrorsOf(create.error);

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4" noValidate>
      <FormError error={create.error} />
      <Field label={t('support.create.summary')} hint={t('support.create.summaryHint')} errorCode={errors.get('title')}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={200}
            value={form.title}
            onChange={(event) => {
              setForm({ ...form, title: event.target.value });
            }}
          />
        )}
      </Field>
      <Field
        label={t('support.create.description')}
        hint={t('support.create.descriptionHint')}
        errorCode={errors.get('description')}
      >
        {(control) => (
          <Textarea
            {...control}
            required
            rows={6}
            maxLength={10000}
            value={form.description}
            onChange={(event) => {
              setForm({ ...form, description: event.target.value });
            }}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('support.severity')} hint={t('support.create.severityHint')} errorCode={errors.get('severity')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.severity}
              onChange={(event) => {
                const severity = TICKET_SEVERITIES.find((value) => value === event.target.value);
                if (severity !== undefined) {
                  setForm({ ...form, severity });
                }
              }}
            >
              {TICKET_SEVERITIES.map((value) => (
                <option key={value} value={value}>
                  {t(`support.severities.${value}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('support.impact')} errorCode={errors.get('impact')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.impact}
              onChange={(event) => {
                const impact = TICKET_IMPACTS.find((value) => value === event.target.value);
                if (impact !== undefined) {
                  setForm({ ...form, impact });
                }
              }}
            >
              {TICKET_IMPACTS.map((value) => (
                <option key={value} value={value}>
                  {t(`support.impacts.${value}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('support.source')} errorCode={errors.get('source')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.source}
              onChange={(event) => {
                const source = TICKET_SOURCES.find((value) => value === event.target.value);
                if (source !== undefined) {
                  setForm({ ...form, source });
                }
              }}
            >
              {TICKET_SOURCES.map((value) => (
                <option key={value} value={value}>
                  {t(`support.sources.${value}`)}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        {setsPriority ? (
          <Field
            label={t('support.priority')}
            hint={t('support.create.priorityHint')}
            errorCode={errors.get('priority')}
            optional
          >
            {(control) => (
              <NativeSelect
                {...control}
                value={form.priority}
                onChange={(event) => {
                  const priority = TICKET_PRIORITIES.find((value) => value === event.target.value);
                  setForm({ ...form, priority: priority ?? '' });
                }}
              >
                <option value="">{t('support.create.priorityAuto')}</option>
                {TICKET_PRIORITIES.map((value) => (
                  <option key={value} value={value}>
                    {t(`support.priorities.${value}`)}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : null}
        {readsProjects ? (
          <Field
            label={t('support.project')}
            hint={t('support.create.projectHint')}
            errorCode={errors.get('projectId')}
            optional
          >
            {(control) => (
              <NativeSelect
                {...control}
                value={form.projectId}
                onChange={(event) => {
                  setForm({ ...form, projectId: event.target.value, componentId: '' });
                }}
              >
                <option value="">{t('support.noProject')}</option>
                {(projects.data?.pages.flatMap((page) => page.data) ?? [])
                  .filter((project) => project.status !== 'ARCHIVED')
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.code} · {project.name}
                    </option>
                  ))}
              </NativeSelect>
            )}
          </Field>
        ) : null}
        <Field label={t('support.category')} errorCode={errors.get('categoryId')} optional>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.categoryId}
              onChange={(event) => {
                setForm({ ...form, categoryId: event.target.value });
              }}
            >
              <option value="">{t('support.none')}</option>
              {(categories.data ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field label={t('support.component')} errorCode={errors.get('componentId')} optional>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.componentId}
              onChange={(event) => {
                setForm({ ...form, componentId: event.target.value });
              }}
            >
              <option value="">{t('support.none')}</option>
              {(components.data ?? []).map((component) => (
                <option key={component.id} value={component.id}>
                  {component.name}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={fileInputId}>{t('support.create.files')}</Label>
        <p id={`${fileInputId}-hint`} className="text-xs text-muted-foreground">
          {t('support.create.filesHint')}
        </p>
        <input
          id={fileInputId}
          type="file"
          multiple
          accept={ALLOWED_TYPES.join(',')}
          aria-describedby={`${fileInputId}-hint`}
          disabled={create.isPending || partial !== null}
          onChange={addFiles}
          className="text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:bg-background file:px-3"
        />
        {fileError === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {fileError}
          </p>
        )}
        {files.length === 0 ? null : (
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="new-ticket-files">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${String(index)}`}
                className="flex min-h-11 items-center justify-between gap-2 px-3"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <PaperclipIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{file.name}</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('support.create.removeFile', { name: file.name })}
                  disabled={create.isPending || partial !== null}
                  onClick={() => {
                    setFiles(files.filter((_, position) => position !== index));
                  }}
                >
                  <XIcon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {progress === null ? null : (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('support.create.attaching', progress)}
        </p>
      )}
      {partial === null ? null : (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive p-3 text-sm">
          <p>{t('support.create.attachFailed', { key: partial.key, names: partial.names })}</p>
          <Button asChild variant="outline" className="self-start">
            <Link href={`/support/tickets/${partial.id}`}>{t('support.create.openTicket')}</Link>
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={create.isPending || partial !== null}>
          {create.isPending ? t('support.create.submitting') : t('support.create.submit')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            router.back();
          }}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
