import { describe, expect, it } from 'vitest';

import { SYSTEM_ROLE_TEMPLATES } from '@company-ops/shared';

import {
  computeEffectivePermissions,
  deserializePermissions,
  hasPermission,
  holdsPrivilegedPermission,
  scopesFor,
  serializePermissions,
} from '../../src/modules/authorization/effective-permissions.js';
import { isMfaSatisfied, MFA_ACR, requiresMfaAtLogin } from '../../src/modules/authorization/mfa.js';
import { assertPermission, canAccessResource } from '../../src/modules/authorization/policy.js';
import type { Principal } from '../../src/modules/authorization/policy.js';
import { ForbiddenError } from '../../src/platform/errors.js';

const ORG = 'org-a';
const principal = (grants: { permissionKey: string; scope: string }[]): Principal => ({
  userId: 'u1',
  memberId: 'm1',
  organizationId: ORG,
  permissions: computeEffectivePermissions(grants),
});

describe('effective permissions', () => {
  it('unions grants from several roles', () => {
    const permissions = computeEffectivePermissions([
      { permissionKey: 'employee.view', scope: 'SELF' },
      { permissionKey: 'employee.view', scope: 'ORG' },
      { permissionKey: 'project.view', scope: 'PROJECT' },
    ]);
    expect(scopesFor(permissions, 'employee.view')).toEqual(['SELF', 'ORG']);
    expect(hasPermission(permissions, 'project.view')).toBe(true);
    expect(hasPermission(permissions, 'role.manage')).toBe(false);
  });

  it('ignores permission keys and scopes outside the code-defined catalog', () => {
    const permissions = computeEffectivePermissions([
      { permissionKey: 'everything.manage', scope: 'ORG' },
      { permissionKey: 'employee.view', scope: 'GLOBAL' },
    ]);
    expect(permissions.size).toBe(0);
  });

  it('round-trips through the serialized session form', () => {
    const permissions = computeEffectivePermissions([
      { permissionKey: 'employee.view', scope: 'ORG' },
      { permissionKey: 'employee.view', scope: 'SELF' },
    ]);
    const serialized = serializePermissions(permissions);
    expect(serialized).toEqual({ 'employee.view': ['SELF', 'ORG'] });
    expect(deserializePermissions(JSON.parse(JSON.stringify(serialized)) as Record<string, string[]>)).toEqual(
      permissions,
    );
  });

  it('detects privileged holders from the baseline templates', () => {
    const grantsOf = (key: keyof typeof SYSTEM_ROLE_TEMPLATES) =>
      computeEffectivePermissions(
        SYSTEM_ROLE_TEMPLATES[key].grants.map((g) => ({ permissionKey: g.permission, scope: g.scope })),
      );
    expect(holdsPrivilegedPermission(grantsOf('ORG_ADMIN'))).toBe(true);
    expect(holdsPrivilegedPermission(grantsOf('HR_ADMIN'))).toBe(true);
    expect(holdsPrivilegedPermission(grantsOf('EMPLOYEE'))).toBe(false);
  });
});

describe('policy', () => {
  it('assertPermission denies a missing permission with 403', () => {
    const p = principal([{ permissionKey: 'employee.view', scope: 'SELF' }]);
    expect(() => {
      assertPermission(p, 'employee.view');
    }).not.toThrow();
    expect(() => {
      assertPermission(p, 'role.manage');
    }).toThrow(ForbiddenError);
  });

  it('ORG scope matches any resource in the active organization only', () => {
    const p = principal([{ permissionKey: 'employee.view', scope: 'ORG' }]);
    expect(canAccessResource(p, 'employee.view', { organizationId: ORG })).toBe(true);
    expect(canAccessResource(p, 'employee.view', { organizationId: 'org-b' })).toBe(false);
  });

  it('SELF scope matches only resources owned by the member', () => {
    const p = principal([{ permissionKey: 'employee.view', scope: 'SELF' }]);
    expect(canAccessResource(p, 'employee.view', { organizationId: ORG, ownerMemberIds: ['m1'] })).toBe(true);
    expect(canAccessResource(p, 'employee.view', { organizationId: ORG, ownerMemberIds: ['m2'] })).toBe(false);
    expect(canAccessResource(p, 'employee.view', { organizationId: ORG })).toBe(false);
  });

  it('TEAM, DEPARTMENT and PROJECT fail closed until their resolvers exist', () => {
    const p = principal([
      { permissionKey: 'employee.view', scope: 'TEAM' },
      { permissionKey: 'employee.view', scope: 'DEPARTMENT' },
      { permissionKey: 'employee.view', scope: 'PROJECT' },
    ]);
    expect(canAccessResource(p, 'employee.view', { organizationId: ORG, ownerMemberIds: ['m1'] })).toBe(false);
  });
});

describe('MFA policy', () => {
  it('requires MFA at login for ORG_ADMIN holders only', () => {
    expect(requiresMfaAtLogin(['EMPLOYEE', 'ORG_ADMIN'])).toBe(true);
    expect(requiresMfaAtLogin(['HR_ADMIN'])).toBe(false);
  });

  it('accepts only a recent mfa authentication', () => {
    const now = 10_000_000;
    expect(isMfaSatisfied({ acr: MFA_ACR, mfaAuthenticatedAt: now - 1000 }, now, 60_000)).toBe(true);
    expect(isMfaSatisfied({ acr: MFA_ACR, mfaAuthenticatedAt: now - 120_000 }, now, 60_000)).toBe(false);
    expect(isMfaSatisfied({ acr: 'pwd', mfaAuthenticatedAt: now }, now, 60_000)).toBe(false);
    expect(isMfaSatisfied({ acr: MFA_ACR, mfaAuthenticatedAt: null }, now, 60_000)).toBe(false);
  });
});
