'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { Label } from '@company-ops/ui/components/input';

import { ApiError } from '../lib/api';
import { useErrorMessage } from './states';

/** `fieldErrors` from a failed request, keyed by top-level field name. */
export function fieldErrorsOf(error: unknown): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  if (error instanceof ApiError) {
    for (const item of error.fieldErrors) {
      const field = item.path.split('.')[0] ?? item.path;
      if (!map.has(field)) {
        map.set(field, item.code);
      }
    }
  }
  return map;
}

export interface ControlProps {
  readonly id: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'aria-describedby'?: string;
}

/** Label, control, hint and inline error wired together with `aria-describedby` (UI_UX.md §7). */
export function Field({
  label,
  hint,
  errorCode,
  optional,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly optional?: boolean;
  readonly children: (control: ControlProps) => ReactNode;
}) {
  const t = useTranslations();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint === undefined ? null : hintId, errorCode === undefined ? null : errorId]
    .filter((value) => value !== null)
    .join(' ');
  const errorText =
    errorCode === undefined
      ? null
      : t.has(`fieldErrors.${errorCode}` as 'fieldErrors.generic')
        ? t(`fieldErrors.${errorCode}` as 'fieldErrors.generic')
        : t('fieldErrors.generic');
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {optional === true ? (
          <span className="ms-1 font-normal text-muted-foreground">({t('common.optional')})</span>
        ) : null}
      </Label>
      {children({
        id,
        ...(errorCode === undefined ? {} : { 'aria-invalid': true }),
        ...(describedBy === '' ? {} : { 'aria-describedby': describedBy }),
      })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {errorText === null ? null : (
        <p id={errorId} className="text-sm text-destructive">
          {errorText}
        </p>
      )}
    </div>
  );
}

/** Error summary at the top of a form, announced to assistive technology. */
export function FormError({ error }: { readonly error: unknown }) {
  const message = useErrorMessage();
  if (error === null || error === undefined) {
    return null;
  }
  return (
    <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
      {message(error)}
    </p>
  );
}

/** Polite live region for confirmations of user-initiated actions. */
export function StatusMessage({ children }: { readonly children: ReactNode }) {
  return (
    <p role="status" aria-live="polite" className="text-sm text-success">
      {children}
    </p>
  );
}
