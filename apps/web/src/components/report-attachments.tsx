'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, PaperclipIcon, Trash2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Label } from '@company-ops/ui/components/input';

import { api, ApiError, request, requestEmpty } from '../lib/api';
import { projectKeys, useAttachments } from '../lib/projects';
import type { AttachmentOwnerType } from '../lib/projects';
import { uploadAttachment } from '../lib/uploads';
import { FormError, StatusMessage } from './form';
import { EmptyState, ErrorState, ListSkeleton, useErrorMessage } from './states';

/** Mirror the server policies per owner type; the server re-checks every upload. */
export const REPORT_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const TICKET_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
] as const;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

type UploadState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'uploading'; readonly filename: string; readonly percent: number }
  | { readonly phase: 'verifying'; readonly filename: string }
  | { readonly phase: 'done'; readonly filename: string }
  | { readonly phase: 'error'; readonly message: string };

function formatSize(bytes: number | null): string {
  if (bytes === null) {
    return '';
  }
  return bytes < 1024 * 1024
    ? `${String(Math.max(1, Math.round(bytes / 1024)))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ReportAttachments({
  reportId,
  canUpload,
  canDelete,
}: {
  readonly reportId: string;
  readonly canUpload: boolean;
  readonly canDelete: boolean;
}) {
  const t = useTranslations('reports.attachments');
  return (
    <Attachments
      ownerType="DAILY_REPORT"
      ownerId={reportId}
      allowedTypes={REPORT_ATTACHMENT_TYPES}
      hint={t('hint')}
      badType={t('badType')}
      testId="report-attachments"
      canUpload={canUpload}
      canDelete={canDelete}
    />
  );
}

export function Attachments({
  ownerType,
  ownerId,
  allowedTypes,
  hint,
  badType,
  testId,
  canUpload,
  canDelete,
  maxBytes = ATTACHMENT_MAX_BYTES,
  tooLarge,
  title,
}: {
  readonly ownerType: AttachmentOwnerType;
  readonly ownerId: string;
  readonly allowedTypes: readonly string[];
  readonly hint: string;
  readonly badType: string;
  readonly testId: string;
  readonly canUpload: boolean;
  readonly canDelete: boolean;
  readonly maxBytes?: number;
  readonly tooLarge?: string;
  readonly title?: string;
}) {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const attachments = useAttachments(ownerType, ownerId);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ phase: 'idle' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: projectKeys.attachments(ownerId) });

  const upload = async (file: File) => {
    if (!allowedTypes.includes(file.type)) {
      setState({ phase: 'error', message: badType });
      return;
    }
    if (file.size > maxBytes) {
      setState({ phase: 'error', message: tooLarge ?? t('reports.attachments.tooLarge') });
      return;
    }
    setState({ phase: 'uploading', filename: file.name, percent: 0 });
    try {
      const attachmentId = await uploadAttachment(ownerType, ownerId, file, {
        onProgress: (percent) => {
          setState({ phase: 'uploading', filename: file.name, percent });
        },
        onVerifying: () => {
          setState({ phase: 'verifying', filename: file.name });
        },
      });
      if (attachmentId === null) {
        setState({ phase: 'error', message: t('reports.attachments.rejected') });
        return;
      }
      setState({ phase: 'done', filename: file.name });
      await refresh();
    } catch (error) {
      setState({
        phase: 'error',
        message:
          error instanceof ApiError && error.code === 'UPLOAD_FAILED'
            ? t('reports.attachments.uploadFailed')
            : errorMessage(error),
      });
    } finally {
      if (inputRef.current !== null) {
        inputRef.current.value = '';
      }
    }
  };

  const onSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) {
      void upload(file);
    }
  };

  const download = useMutation({
    mutationFn: async (id: string) =>
      (await request(() => api.GET('/api/v1/attachments/{id}/download-url', { params: { path: { id } } }))).data.url,
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      requestEmpty(() => api.DELETE('/api/v1/attachments/{id}', { params: { path: { id } } })),
    onSuccess: refresh,
  });

  const busy = state.phase === 'uploading' || state.phase === 'verifying';

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-3">
      <h2 id={`${inputId}-title`} className="text-lg font-semibold">
        {title ?? t('reports.attachments.title')}
      </h2>
      {attachments.isPending ? (
        <ListSkeleton rows={2} />
      ) : attachments.isError ? (
        <ErrorState
          error={attachments.error}
          onRetry={() => {
            void attachments.refetch();
          }}
        />
      ) : attachments.data.length === 0 ? (
        <EmptyState message={t('reports.attachments.empty')} />
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border" data-testid={testId}>
          {attachments.data.map((attachment) => (
            <li key={attachment.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <PaperclipIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{attachment.filename}</span>
                <span className="text-xs text-muted-foreground">{formatSize(attachment.sizeBytes)}</span>
              </span>
              <span className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={download.isPending}
                  onClick={() => {
                    download.mutate(attachment.id);
                  }}
                >
                  <DownloadIcon aria-hidden="true" />
                  {t('reports.attachments.download')}
                  <span className="sr-only">{attachment.filename}</span>
                </Button>
                {canDelete ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('reports.attachments.delete', { name: attachment.filename })}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(t('reports.attachments.confirmDelete', { name: attachment.filename }))) {
                        remove.mutate(attachment.id);
                      }
                    }}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      <FormError error={download.error ?? remove.error} />
      {canUpload ? (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed p-4">
          <Label htmlFor={inputId}>{t('reports.attachments.add')}</Label>
          <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={allowedTypes.join(',')}
            aria-describedby={`${inputId}-hint`}
            disabled={busy}
            onChange={onSelect}
            className="text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:bg-background file:px-3"
          />
          {state.phase === 'uploading' ? (
            <div className="flex flex-col gap-1">
              <progress
                className="h-2 w-full"
                max={100}
                value={state.percent}
                aria-label={t('reports.attachments.uploading', { name: state.filename })}
              />
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {t('reports.attachments.progress', { name: state.filename, percent: state.percent })}
              </p>
            </div>
          ) : null}
          {state.phase === 'verifying' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('reports.attachments.verifying', { name: state.filename })}
            </p>
          ) : null}
          {state.phase === 'done' ? (
            <StatusMessage>{t('reports.attachments.uploaded', { name: state.filename })}</StatusMessage>
          ) : null}
          {state.phase === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
