import { isPermissionKey, isPrivilegedPermission, isScope, SCOPES } from '@company-ops/shared';
import type { PermissionKey, Scope } from '@company-ops/shared';

/** Union of a member's role grants: permission -> scopes (SECURITY §2.1, grants union). */
export type EffectivePermissions = ReadonlyMap<PermissionKey, ReadonlySet<Scope>>;

/** Serializable form stored in the session cache. */
export type SerializedPermissions = Readonly<Partial<Record<PermissionKey, readonly Scope[]>>>;

export interface GrantRow {
  readonly permissionKey: string;
  readonly scope: string;
}

/**
 * Builds effective permissions from role grant rows. Keys or scopes not in the code-defined catalog
 * are ignored, so a stale or tampered row can never create a capability the code does not know.
 */
export function computeEffectivePermissions(grants: Iterable<GrantRow>): EffectivePermissions {
  const result = new Map<PermissionKey, Set<Scope>>();
  for (const grant of grants) {
    if (!isPermissionKey(grant.permissionKey) || !isScope(grant.scope)) {
      continue;
    }
    let scopes = result.get(grant.permissionKey);
    if (scopes === undefined) {
      scopes = new Set();
      result.set(grant.permissionKey, scopes);
    }
    scopes.add(grant.scope);
  }
  return result;
}

const scopeOrder = (scope: Scope): number => SCOPES.indexOf(scope);

export function serializePermissions(permissions: EffectivePermissions): SerializedPermissions {
  const result: Partial<Record<PermissionKey, Scope[]>> = {};
  for (const [key, scopes] of permissions) {
    result[key] = [...scopes].sort((a, b) => scopeOrder(a) - scopeOrder(b));
  }
  return result;
}

export function deserializePermissions(serialized: Readonly<Record<string, readonly string[]>>): EffectivePermissions {
  const rows: GrantRow[] = [];
  for (const [permissionKey, scopes] of Object.entries(serialized)) {
    for (const scope of scopes) {
      rows.push({ permissionKey, scope });
    }
  }
  return computeEffectivePermissions(rows);
}

export function hasPermission(permissions: EffectivePermissions, permission: PermissionKey): boolean {
  return (permissions.get(permission)?.size ?? 0) > 0;
}

export function scopesFor(permissions: EffectivePermissions, permission: PermissionKey): readonly Scope[] {
  const scopes = permissions.get(permission);
  return scopes === undefined ? [] : [...scopes].sort((a, b) => scopeOrder(a) - scopeOrder(b));
}

/** True when the member holds any privileged capability (SECURITY §2.3). */
export function holdsPrivilegedPermission(permissions: EffectivePermissions): boolean {
  for (const key of permissions.keys()) {
    if (isPrivilegedPermission(key)) {
      return true;
    }
  }
  return false;
}
