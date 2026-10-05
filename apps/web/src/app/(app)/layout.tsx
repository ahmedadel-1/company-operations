import type { ReactNode } from 'react';

import { Providers } from '../../components/providers';
import { AppShell } from '../../components/shell';

/** Every route in this group requires a session; src/proxy.ts sends visitors without one to sign-in. */
export default function AuthenticatedLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Providers>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}
