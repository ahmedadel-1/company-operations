import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { Button } from '@company-ops/ui/components/button';

export default async function NotFound() {
  const t = await getTranslations('states');
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-semibold">{t('notFoundTitle')}</h1>
      <p className="text-muted-foreground">{t('notFoundBody')}</p>
      <Button asChild variant="outline">
        <Link href="/">{t('backHome')}</Link>
      </Button>
    </main>
  );
}
