'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';

import { Button } from '@company-ops/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Label } from '@company-ops/ui/components/input';

import { api, ApiError, request } from '../lib/api';
import { queryKeys } from '../lib/queries';
import { uploadAttachment } from '../lib/uploads';
import { FormError, StatusMessage } from './form';
import { useErrorMessage } from './states';

/** Mirrors the server policy for avatars; the server re-checks every upload. */
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

interface AvatarOwner {
  readonly id: string;
  readonly fullName: string;
  readonly hasAvatar: boolean;
  readonly updatedAt: string;
}

type AvatarState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'uploading'; readonly percent: number }
  | { readonly phase: 'verifying' }
  | { readonly phase: 'done'; readonly message: string }
  | { readonly phase: 'error'; readonly message: string };

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** The employee's photo through a short-lived download URL, or their initials. */
export function EmployeeAvatar({ employee, size = 96 }: { readonly employee: AvatarOwner; readonly size?: number }) {
  const t = useTranslations('people.avatar');
  const url = useQuery({
    // The profile's `updatedAt` changes with the avatar, so a new photo gets a new URL.
    queryKey: ['employees', 'avatar', employee.id, employee.updatedAt],
    enabled: employee.hasAvatar,
    staleTime: 60_000,
    queryFn: async () =>
      (await request(() => api.GET('/api/v1/employees/{id}/avatar-url', { params: { path: { id: employee.id } } })))
        .data.url,
  });
  const style = { width: size, height: size };
  if (employee.hasAvatar && url.data !== undefined) {
    return (
      // Pre-signed, short-lived object-storage URL: served as is, never through the image optimizer.
      <Image
        unoptimized
        src={url.data}
        alt={t('alt', { name: employee.fullName })}
        width={size}
        height={size}
        style={style}
        className="rounded-full border object-cover"
        data-testid="employee-avatar"
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={t('alt', { name: employee.fullName })}
      style={style}
      className="inline-flex items-center justify-center rounded-full border bg-muted text-2xl font-semibold text-muted-foreground"
    >
      {initials(employee.fullName)}
    </span>
  );
}

/** Photo with upload and removal for the employee themself or an employee manager (server-enforced). */
export function AvatarCard({ employee, canChange }: { readonly employee: AvatarOwner; readonly canChange: boolean }) {
  const t = useTranslations('people.avatar');
  const errorMessage = useErrorMessage();
  const queryClient = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<AvatarState>({ phase: 'idle' });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['employees'] });
    await queryClient.invalidateQueries({ queryKey: queryKeys.ownProfile });
  };
  const setAvatar = (attachmentId: string | null) =>
    request(() =>
      api.PUT('/api/v1/employees/{id}/avatar', { params: { path: { id: employee.id } }, body: { attachmentId } }),
    );

  const upload = async (file: File) => {
    if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) {
      setState({ phase: 'error', message: t('badType') });
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      setState({ phase: 'error', message: t('tooLarge') });
      return;
    }
    setState({ phase: 'uploading', percent: 0 });
    try {
      const attachmentId = await uploadAttachment('EMPLOYEE_AVATAR', employee.id, file, {
        onProgress: (percent) => {
          setState({ phase: 'uploading', percent });
        },
        onVerifying: () => {
          setState({ phase: 'verifying' });
        },
      });
      if (attachmentId === null) {
        setState({ phase: 'error', message: t('rejected') });
        return;
      }
      await setAvatar(attachmentId);
      setState({ phase: 'done', message: t('uploaded') });
      await refresh();
    } catch (error) {
      setState({
        phase: 'error',
        message: error instanceof ApiError && error.code === 'UPLOAD_FAILED' ? t('uploadFailed') : errorMessage(error),
      });
    } finally {
      if (inputRef.current !== null) {
        inputRef.current.value = '';
      }
    }
  };

  const remove = useMutation({
    mutationFn: () => setAvatar(null),
    onSuccess: async () => {
      setState({ phase: 'done', message: t('removed') });
      await refresh();
    },
  });

  const onSelect = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) {
      void upload(file);
    }
  };
  const busy = state.phase === 'uploading' || state.phase === 'verifying' || remove.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <EmployeeAvatar employee={employee} />
        {canChange ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Label htmlFor={inputId}>{t('upload')}</Label>
            <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
              {t('hint')}
            </p>
            <input
              ref={inputRef}
              id={inputId}
              type="file"
              accept={AVATAR_TYPES.join(',')}
              aria-describedby={`${inputId}-hint`}
              disabled={busy}
              onChange={onSelect}
              className="text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:bg-background file:px-3"
            />
            {state.phase === 'uploading' ? (
              <progress className="h-2 w-full" max={100} value={state.percent} aria-label={t('uploading')} />
            ) : null}
            {state.phase === 'uploading' || state.phase === 'verifying' ? (
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {state.phase === 'uploading' ? t('progress', { percent: state.percent }) : t('verifying')}
              </p>
            ) : null}
            {state.phase === 'done' ? <StatusMessage>{state.message}</StatusMessage> : null}
            {state.phase === 'error' ? (
              <p role="alert" className="text-sm text-destructive">
                {state.message}
              </p>
            ) : null}
            <FormError error={remove.error} />
            {employee.hasAvatar ? (
              <Button
                variant="outline"
                className="self-start"
                disabled={busy}
                onClick={() => {
                  remove.mutate();
                }}
              >
                {t('remove')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
