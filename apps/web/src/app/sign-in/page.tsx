import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { Button } from '@company-ops/ui/components/button';

const KNOWN_ERRORS = [
  'no_active_membership',
  'invitation_invalid',
  'callback_rejected',
  'transaction_missing',
] as const;
type KnownError = (typeof KNOWN_ERRORS)[number];

function isKnownError(value: string): value is KnownError {
  return (KNOWN_ERRORS as readonly string[]).includes(value);
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth');
  return { title: t('signInTitle') };
}

/** Public page: explains why sign-in failed (`?authError=`) and offers a fresh attempt. No automatic redirect. */
export default async function SignInPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ authError?: string | string[] }>;
}) {
  const t = await getTranslations();
  const { authError } = await searchParams;
  const reason = typeof authError === 'string' ? authError : null;
  const message =
    reason === null ? null : isKnownError(reason) ? t(`auth.authErrors.${reason}`) : t('auth.authErrors.generic');

  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 p-6">
      <p className="font-semibold">{t('app.name')}</p>
      <h1 className="text-2xl font-semibold tracking-tight">{t('auth.signInTitle')}</h1>
      {message === null ? (
        <p className="text-muted-foreground">{t('auth.signInBody')}</p>
      ) : (
        <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm">
          {message}
        </p>
      )}
      <Button asChild className="self-start">
        <a href="/api/v1/auth/login">{t('auth.signIn')}</a>
      </Button>
    </main>
  );
}
