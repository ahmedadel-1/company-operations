'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, PaperclipIcon, XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ChangeEvent, SubmitEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent } from '@company-ops/ui/components/card';
import { Label } from '@company-ops/ui/components/input';

import { FormError } from '../../../../components/form';
import { RequestFormFields, toFormData } from '../../../../components/request-form';
import type { FormDraft, MemberNames } from '../../../../components/request-form';
import { RequestTypeIconView } from '../../../../components/requests';
import { EmptyState, ErrorState, Forbidden, ListSkeleton, PageHeader } from '../../../../components/states';
import { api, ApiError, request } from '../../../../lib/api';
import {
  formFieldErrors,
  REQUEST_ATTACHMENT_TYPES,
  requestKeys,
  useLocalized,
  useRequestCatalog,
  useRequestForm,
} from '../../../../lib/requests';
import type { RequestDetail, RequestForm } from '../../../../lib/requests';
import { useCan } from '../../../../lib/session';
import { uploadAttachment } from '../../../../lib/uploads';
import type { UploadCallbacks } from '../../../../lib/uploads';

const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES: readonly string[] = REQUEST_ATTACHMENT_TYPES;
const NO_PROGRESS: UploadCallbacks = { onProgress: () => undefined, onVerifying: () => undefined };
const UUID = /^[0-9a-f-]{36}$/i;

function initialType(): string | null {
  const value = new URLSearchParams(window.location.search).get('type');
  return value !== null && UUID.test(value) ? value : null;
}

export default function NewRequestPage() {
  const t = useTranslations();
  const can = useCan();
  const router = useRouter();
  const [typeId, setTypeId] = useState<string | null>(initialType);
  if (!can('request.create')) {
    return <Forbidden />;
  }
  const choose = (id: string | null) => {
    setTypeId(id);
    router.replace(id === null ? '/requests/new' : `/requests/new?type=${id}`);
  };
  return typeId === null ? (
    <>
      <PageHeader title={t('requests.create.title')} description={t('requests.create.chooseType')} />
      <TypeCatalog onChoose={choose} />
    </>
  ) : (
    <TypeForm
      typeId={typeId}
      onBack={() => {
        choose(null);
      }}
    />
  );
}

function TypeCatalog({ onChoose }: { readonly onChoose: (id: string) => void }) {
  const t = useTranslations();
  const localized = useLocalized();
  const catalog = useRequestCatalog();
  if (catalog.isPending) return <ListSkeleton rows={4} />;
  if (catalog.isError) {
    return (
      <ErrorState
        error={catalog.error}
        onRetry={() => {
          void catalog.refetch();
        }}
      />
    );
  }
  if (catalog.data.length === 0) return <EmptyState message={t('requests.create.noTypes')} />;
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('requests.create.types')}>
      {catalog.data.map((type) => (
        <li key={type.id}>
          <button
            type="button"
            data-testid="request-type-option"
            data-key={type.key}
            className="flex h-full min-h-24 w-full flex-col items-start gap-2 rounded-lg border p-4 text-start hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={() => {
              onChoose(type.id);
            }}
          >
            <span className="flex items-center gap-2 font-medium">
              <RequestTypeIconView icon={type.icon} className="size-5 text-muted-foreground" />
              {localized(type.name)}
            </span>
            {type.description === null ? null : (
              <span className="text-sm text-muted-foreground">{localized(type.description)}</span>
            )}
            <span className="text-xs text-muted-foreground">{t(`requests.categories.${type.category}`)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TypeForm({ typeId, onBack }: { readonly typeId: string; readonly onBack: () => void }) {
  const t = useTranslations();
  const localized = useLocalized();
  const form = useRequestForm(typeId);
  const header = (
    <Button variant="ghost" className="mb-2 self-start" onClick={onBack}>
      <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />
      {t('requests.create.otherType')}
    </Button>
  );
  if (form.isPending) {
    return (
      <div className="flex flex-col">
        {header}
        <ListSkeleton rows={4} />
      </div>
    );
  }
  if (form.isError) {
    return (
      <div className="flex flex-col">
        {header}
        <ErrorState
          error={form.error}
          onRetry={() => {
            void form.refetch();
          }}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {header}
      <PageHeader
        title={localized(form.data.requestType.name)}
        description={
          form.data.requestType.description === null
            ? t('requests.create.intro')
            : localized(form.data.requestType.description)
        }
      />
      <NewRequestForm key={form.data.workflowVersionId} form={form.data} />
    </div>
  );
}

interface Outcome {
  readonly request: RequestDetail;
  readonly failed: readonly string[];
  readonly submitted: boolean;
}

function NewRequestForm({ form }: { readonly form: RequestForm }) {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  // One key per form instance: a retried or double-submitted create makes one request only.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [draft, setDraft] = useState<FormDraft>({});
  const [memberNames, setMemberNames] = useState<MemberNames>({});
  const [created, setCreated] = useState<RequestDetail | null>(null);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ readonly current: number; readonly total: number } | null>(null);
  const fileInputId = useId();
  const policy = form.attachments;
  const acceptsFiles = policy.requirement !== 'NONE';

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(event.target.files ?? [])];
    event.target.value = '';
    if (chosen.some((file) => !ALLOWED_TYPES.includes(file.type))) {
      setFileError(t('requests.attachments.badType'));
      return;
    }
    if (chosen.some((file) => file.size > ATTACHMENT_MAX_BYTES)) {
      setFileError(t('requests.attachments.tooLarge'));
      return;
    }
    if (files.length + chosen.length > policy.maxFiles) {
      setFileError(t('requests.attachments.tooMany', { max: policy.maxFiles }));
      return;
    }
    setFileError(null);
    setFiles([...files, ...chosen]);
  };

  const save = useMutation({
    mutationFn: async (submit: boolean): Promise<Outcome> => {
      const formData = toFormData(form.form, draft);
      // Without files the request is created and submitted in one transaction.
      if (created === null && files.length === 0) {
        const result = (
          await request(() =>
            api.POST('/api/v1/requests', {
              params: { header: { 'Idempotency-Key': idempotencyKey } },
              body: { requestTypeId: form.requestType.id, formData, submit },
            }),
          )
        ).data;
        return { request: result, failed: [], submitted: submit };
      }
      // With files: keep a draft, attach, then submit (the server checks the attachment policy at submit).
      let current =
        created === null
          ? (
              await request(() =>
                api.POST('/api/v1/requests', {
                  params: { header: { 'Idempotency-Key': idempotencyKey } },
                  body: { requestTypeId: form.requestType.id, formData, submit: false },
                }),
              )
            ).data
          : (
              await request(() =>
                api.PATCH('/api/v1/requests/{id}', {
                  params: { path: { id: created.id } },
                  body: { version: created.version, formData },
                }),
              )
            ).data;
      setCreated(current);
      const failed: string[] = [];
      const remaining: File[] = [];
      for (const [index, file] of files.entries()) {
        setProgress({ current: index + 1, total: files.length });
        const attached = await uploadAttachment('REQUEST', current.id, file, NO_PROGRESS).then(
          (id) => id !== null,
          () => false,
        );
        if (!attached) {
          failed.push(file.name);
          remaining.push(file);
        }
      }
      setFiles(remaining);
      if (!submit || failed.length > 0) {
        return { request: current, failed, submitted: false };
      }
      current = (
        await request(() =>
          api.POST('/api/v1/requests/{id}/submit', {
            params: { path: { id: current.id } },
            body: { version: current.version },
          }),
        )
      ).data;
      return { request: current, failed: [], submitted: true };
    },
    onSettled: () => {
      setProgress(null);
    },
    onSuccess: async ({ request: saved, failed }) => {
      queryClient.setQueryData(requestKeys.detail(saved.id), saved);
      await queryClient.invalidateQueries({ queryKey: requestKeys.lists });
      if (failed.length === 0) {
        router.push(`/requests/${saved.id}`);
      }
    },
  });

  const errors = formFieldErrors(save.error instanceof ApiError ? save.error.fieldErrors : []);
  const failedNames = save.data?.failed ?? [];
  const busy = save.isPending;

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate(true);
  };

  return (
    <Card className="max-w-2xl">
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate data-testid="new-request-form">
          <FormError error={save.error} />
          {form.form.fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('requests.create.noFields')}</p>
          ) : null}
          <RequestFormFields
            schema={form.form}
            draft={draft}
            onChange={setDraft}
            errors={errors}
            memberNames={memberNames}
            onMemberName={(id, name) => {
              setMemberNames((names) => ({ ...names, [id]: name }));
            }}
            disabled={busy}
          />
          {acceptsFiles ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor={fileInputId}>
                {t('requests.attachments.title')}
                {policy.requirement === 'OPTIONAL' ? (
                  <span className="ms-1 font-normal text-muted-foreground">({t('common.optional')})</span>
                ) : null}
              </Label>
              <p id={`${fileInputId}-hint`} className="text-xs text-muted-foreground">
                {t('requests.attachments.hint', { max: policy.maxFiles })}
              </p>
              <input
                id={fileInputId}
                type="file"
                multiple
                accept={ALLOWED_TYPES.join(',')}
                aria-describedby={`${fileInputId}-hint`}
                disabled={busy}
                onChange={addFiles}
                className="text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:bg-background file:px-3"
              />
              {fileError === null ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {fileError}
                </p>
              )}
              {errors.get('attachments') === undefined ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {t(
                    errors.get('attachments') === 'required'
                      ? 'requests.attachments.required'
                      : 'requests.attachments.invalid',
                  )}
                </p>
              )}
              {files.length === 0 ? null : (
                <ul className="flex flex-col divide-y rounded-lg border" data-testid="new-request-files">
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
                        aria-label={t('requests.attachments.remove', { name: file.name })}
                        disabled={busy}
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
          ) : null}
          {progress === null ? null : (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('requests.attachments.attaching', progress)}
            </p>
          )}
          {failedNames.length === 0 || created === null ? null : (
            <div role="alert" className="flex flex-col gap-2 rounded-lg border border-destructive p-3 text-sm">
              <p>{t('requests.attachments.attachFailed', { key: created.key, names: failedNames.join(', ') })}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy} data-testid="submit-request">
              {busy ? t('requests.create.submitting') : t('requests.create.submit')}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                save.mutate(false);
              }}
            >
              {t('requests.create.saveDraft')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
