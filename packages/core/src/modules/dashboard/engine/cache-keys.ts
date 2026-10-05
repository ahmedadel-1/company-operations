import { createHash } from 'node:crypto';

import type { PermissionKey } from '@company-ops/shared';

import { listScope } from '../../authorization/policy.js';
import type { Principal } from '../../authorization/policy.js';

/** Data domains whose changes retire cached dashboards (ADR-0023). */
export type DashboardDomain = 'support' | 'projects' | 'requests' | 'attendance' | 'jira' | 'github' | 'commercial';

export const DASHBOARD_DOMAINS: readonly DashboardDomain[] = [
  'support',
  'projects',
  'requests',
  'attendance',
  'jira',
  'github',
  'commercial',
];

const CACHE_VERSION = 'v1';

/**
 * Canonical description of what a principal can see through `permissions`: per permission the ORG
 * flag and the sorted member/department/project id sets, plus the member id when the result is
 * personal. Equal descriptions = equal visible data, so a cache entry is only ever shared by
 * principals with identical effective scopes.
 */
export function scopeDescriptor(
  principal: Principal,
  permissions: readonly PermissionKey[],
  personal: boolean,
): string {
  const parts = [...new Set(permissions)].sort().map((permission) => {
    const scope = listScope(principal, permission);
    return [
      permission,
      scope.all ? 'ORG' : '',
      scope.memberIds.join(','),
      scope.departmentIds.join(','),
      scope.projectIds.join(','),
    ].join('|');
  });
  return JSON.stringify({ org: principal.organizationId, member: personal ? principal.memberId : null, parts });
}

export function scopeHash(descriptor: string): string {
  return createHash('sha256').update(descriptor).digest('hex');
}

/** `dash:ver:{org}:{domain}`: incremented on every change event of the domain. */
export function versionKey(organizationId: string, domain: DashboardDomain): string {
  return `dash:ver:${organizationId}:${domain}`;
}

export function versionsTag(domains: readonly DashboardDomain[], versions: readonly (string | null)[]): string {
  return domains.map((domain, index) => `${domain}=${versions[index] ?? '0'}`).join(';');
}

/** `dash:v1:{org}:{dashboard}:{scopeHash}:{versionsHash}` — tenant first, then scope, then data versions. */
export function dashboardCacheKey(organizationId: string, dashboard: string, scope: string, versions: string): string {
  const versionsHash = createHash('sha256').update(versions).digest('hex').slice(0, 16);
  return `dash:${CACHE_VERSION}:${organizationId}:${dashboard}:${scope}:${versionsHash}`;
}
