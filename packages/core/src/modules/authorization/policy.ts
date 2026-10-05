import type { PermissionKey, Scope } from '@company-ops/shared';

import { ForbiddenError } from '../../platform/errors.js';
import { hasPermission, scopesFor } from './effective-permissions.js';
import type { EffectivePermissions } from './effective-permissions.js';

/**
 * What TEAM, DEPARTMENT and PROJECT scopes reach for one member, resolved from the database by
 * `ScopeReachResolver` (never from client input).
 */
export interface ScopeReach {
  /** Direct and indirect reports plus members of teams the member leads (SECURITY §2.1). */
  readonly teamMemberIds: ReadonlySet<string>;
  /** Departments the member manages and their descendants. */
  readonly departmentIds: ReadonlySet<string>;
  /** Projects the member staffs: project member, project manager or technical manager. */
  readonly projectIds: ReadonlySet<string>;
}

export const EMPTY_REACH: ScopeReach = Object.freeze({
  teamMemberIds: new Set<string>(),
  departmentIds: new Set<string>(),
  projectIds: new Set<string>(),
});

/** The authenticated member a decision is made for (server-derived, never client input). */
export interface Principal {
  readonly userId: string;
  readonly memberId: string;
  readonly organizationId: string;
  readonly permissions: EffectivePermissions;
  /** Absent = not resolved: TEAM, DEPARTMENT and PROJECT grants then never match (fail closed). */
  readonly reach?: ScopeReach | undefined;
}

/**
 * Facts about a loaded resource that scopes are evaluated against. Each module supplies what it
 * knows; a scope whose fact is absent never matches (fail closed).
 */
export interface ResourceFacts {
  readonly organizationId: string;
  /** Member who owns/created/is assigned the resource, or the member the resource is (SELF). */
  readonly ownerMemberIds?: readonly string[];
  /** Members the resource belongs to, matched against the TEAM reach. */
  readonly subjectMemberIds?: readonly string[];
  /** Departments the resource belongs to, matched against the DEPARTMENT reach. */
  readonly departmentIds?: readonly string[];
  /** Projects the resource belongs to, matched against the PROJECT reach. */
  readonly projectIds?: readonly string[];
}

/**
 * Route-level capability check (`PermissionGuard`): the member holds the permission at any scope.
 * Throws 403 FORBIDDEN otherwise.
 */
export function assertPermission(principal: Principal, permission: PermissionKey): void {
  if (!hasPermission(principal.permissions, permission)) {
    throw new ForbiddenError();
  }
}

/** Resource-level scope evaluation (SECURITY §2.2): allows when ANY granted scope matches. */
export function canAccessResource(principal: Principal, permission: PermissionKey, resource: ResourceFacts): boolean {
  if (resource.organizationId !== principal.organizationId) {
    return false;
  }
  return scopesFor(principal.permissions, permission).some((scope) => scopeMatches(scope, principal, resource));
}

const intersects = (values: readonly string[] | undefined, set: ReadonlySet<string> | undefined): boolean =>
  values !== undefined && set !== undefined && values.some((value) => set.has(value));

function scopeMatches(scope: Scope, principal: Principal, resource: ResourceFacts): boolean {
  switch (scope) {
    case 'ORG':
      return true;
    case 'SELF':
      return resource.ownerMemberIds?.includes(principal.memberId) ?? false;
    case 'TEAM':
      return intersects(resource.subjectMemberIds, principal.reach?.teamMemberIds);
    case 'DEPARTMENT':
      return intersects(resource.departmentIds, principal.reach?.departmentIds);
    case 'PROJECT':
      return intersects(resource.projectIds, principal.reach?.projectIds);
  }
}

/**
 * A permission's scopes compiled for list queries (`policy.scopeFilter`, SECURITY §2.2). Modules
 * translate it into a `where` fragment that is AND-ed with the organization binding:
 * `all` = no extra restriction; otherwise rows match when their owner/subject member is in
 * `memberIds`, or their department is in `departmentIds`, or their project is in `projectIds`.
 * Nothing granted (or nothing reachable) yields empty sets, i.e. no rows.
 */
export interface ListScope {
  readonly all: boolean;
  readonly memberIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly projectIds: readonly string[];
}

export function listScope(principal: Principal, permission: PermissionKey): ListScope {
  const scopes = new Set(scopesFor(principal.permissions, permission));
  if (scopes.has('ORG')) {
    return { all: true, memberIds: [], departmentIds: [], projectIds: [] };
  }
  const members = new Set<string>();
  if (scopes.has('SELF')) {
    members.add(principal.memberId);
  }
  if (scopes.has('TEAM')) {
    for (const id of principal.reach?.teamMemberIds ?? []) {
      members.add(id);
    }
  }
  return {
    all: false,
    memberIds: [...members].sort(),
    departmentIds: scopes.has('DEPARTMENT') ? [...(principal.reach?.departmentIds ?? [])].sort() : [],
    projectIds: scopes.has('PROJECT') ? [...(principal.reach?.projectIds ?? [])].sort() : [],
  };
}

/** True when the list scope can match no row at all (the query can be skipped). */
export function isEmptyListScope(scope: ListScope): boolean {
  return (
    !scope.all && scope.memberIds.length === 0 && scope.departmentIds.length === 0 && scope.projectIds.length === 0
  );
}

/** Scopes that need the database-resolved reach; ORG/SELF-only principals skip the lookup. */
export function needsReach(permissions: EffectivePermissions): boolean {
  for (const scopes of permissions.values()) {
    if (scopes.has('TEAM') || scopes.has('DEPARTMENT') || scopes.has('PROJECT')) {
      return true;
    }
  }
  return false;
}
