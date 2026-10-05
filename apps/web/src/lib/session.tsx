'use client';

import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { paths } from '@company-ops/api-client';
import type { PermissionKey } from '@company-ops/shared';

export type Me = paths['/api/v1/me']['get']['responses'][200]['content']['application/json']['data'];

const MeContext = createContext<Me | null>(null);

export function MeProvider({ me, children }: { readonly me: Me; readonly children: ReactNode }) {
  return <MeContext value={me}>{children}</MeContext>;
}

/** The signed-in member. Only available inside the authenticated shell. */
export function useSession(): Me {
  const me = use(MeContext);
  if (me === null) {
    throw new Error('useSession() used outside the authenticated shell');
  }
  return me;
}

/** UX only: hides what the member cannot use. The API enforces every permission (SECURITY §2.2). */
export function useCan(): (permission: PermissionKey) => boolean {
  const me = useSession();
  return (permission) => me.permissions.some((grant) => grant.key === permission);
}

/** UX only: whether the member holds the permission organization-wide (not only for some projects or teams). */
export function useCanOrgWide(): (permission: PermissionKey) => boolean {
  const me = useSession();
  return (permission) => me.permissions.some((grant) => grant.key === permission && grant.scopes.includes('ORG'));
}
