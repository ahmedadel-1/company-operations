import { describe, expect, it } from 'vitest';

import {
  isPermissionKey,
  isPrivilegedPermission,
  PERMISSION_KEYS,
  PRIVILEGED_PERMISSIONS,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLE_TEMPLATES,
} from '../src/index.js';
import type { PermissionKey, Scope, SystemRoleKey } from '../src/index.js';

function scopesOf(role: SystemRoleKey, permission: PermissionKey): Scope[] {
  return SYSTEM_ROLE_TEMPLATES[role].grants.filter((g) => g.permission === permission).map((g) => g.scope);
}

describe('permission catalog', () => {
  it('has unique, dotted keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length);
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/);
    }
  });

  it('recognizes only catalog keys', () => {
    expect(isPermissionKey('role.manage')).toBe(true);
    expect(isPermissionKey('role.manage_everything')).toBe(false);
    expect(isPermissionKey('')).toBe(false);
  });

  it('marks exactly the SECURITY §2.3 permissions as privileged', () => {
    expect([...PRIVILEGED_PERMISSIONS].sort()).toEqual(
      [
        'attendance.admin',
        'audit.view',
        'employee.manage',
        'integration.manage',
        'org.settings.manage',
        'request.admin',
        'role.manage',
      ].sort(),
    );
    expect(isPrivilegedPermission('employee.view')).toBe(false);
  });
});

describe('system role templates (SECURITY §2.5 baseline)', () => {
  it('defines the ten tenant roles and no platform role', () => {
    expect(SYSTEM_ROLE_KEYS).toHaveLength(10);
    expect(SYSTEM_ROLE_KEYS).not.toContain('SUPER_ADMIN');
  });

  it('only grants catalog permissions, each at most once per scope', () => {
    for (const role of SYSTEM_ROLE_KEYS) {
      const grants = SYSTEM_ROLE_TEMPLATES[role].grants;
      expect(grants.length).toBeGreaterThan(0);
      const pairs = grants.map((g) => `${g.permission}:${g.scope}`);
      expect(new Set(pairs).size).toBe(pairs.length);
      for (const grant of grants) {
        expect(isPermissionKey(grant.permission)).toBe(true);
      }
    }
  });

  it('gives every member the universal self-service grants', () => {
    for (const role of SYSTEM_ROLE_KEYS) {
      for (const permission of ['support.create', 'request.create', 'request.approve', 'attendance.self'] as const) {
        expect(scopesOf(role, permission)).toEqual(['SELF']);
      }
      expect(scopesOf(role, 'employee.view')).toEqual(['ORG']);
    }
  });

  it('keeps org admins configuring, not operating support or dashboards', () => {
    expect(scopesOf('ORG_ADMIN', 'role.manage')).toEqual(['ORG']);
    expect(scopesOf('ORG_ADMIN', 'org.settings.manage')).toEqual(['ORG']);
    expect(scopesOf('ORG_ADMIN', 'support.view')).toEqual(['SELF']);
    expect(scopesOf('ORG_ADMIN', 'support.triage')).toEqual([]);
    expect(scopesOf('ORG_ADMIN', 'dashboard.executive')).toEqual([]);
    expect(scopesOf('ORG_ADMIN', 'attendance.admin')).toEqual([]);
  });

  it('matches representative cells of the matrix', () => {
    expect(scopesOf('GENERAL_MANAGER', 'audit.view')).toEqual(['ORG']);
    expect(scopesOf('GENERAL_MANAGER', 'project.manage')).toEqual([]);
    expect(scopesOf('TECHNICAL_MANAGER', 'request.view')).toEqual(['TEAM']);
    expect(scopesOf('DEPARTMENT_MANAGER', 'employee.view_contact')).toEqual(['DEPARTMENT']);
    expect(scopesOf('PROJECT_MANAGER', 'project.assign_members')).toEqual(['PROJECT']);
    expect(scopesOf('TEAM_LEAD', 'support.resolve')).toEqual(['PROJECT']);
    expect(scopesOf('HR_ADMIN', 'attendance.admin')).toEqual(['ORG']);
    expect(scopesOf('HR_ADMIN', 'project.view')).toEqual([]);
    expect(scopesOf('SUPPORT_AGENT', 'support.close')).toEqual(['ORG']);
    expect(scopesOf('FIELD_EMPLOYEE', 'daily_report.submit')).toEqual(['PROJECT']);
    expect(scopesOf('EMPLOYEE', 'project.view')).toEqual(['PROJECT']);
    expect(scopesOf('EMPLOYEE', 'role.manage')).toEqual([]);
  });

  it('grants privileged permissions only to the roles the baseline names', () => {
    const holders = new Map<PermissionKey, SystemRoleKey[]>();
    for (const role of SYSTEM_ROLE_KEYS) {
      for (const grant of SYSTEM_ROLE_TEMPLATES[role].grants) {
        if (isPrivilegedPermission(grant.permission)) {
          holders.set(grant.permission, [...(holders.get(grant.permission) ?? []), role]);
        }
      }
    }
    expect(Object.fromEntries(holders)).toEqual({
      'org.settings.manage': ['ORG_ADMIN'],
      'role.manage': ['ORG_ADMIN'],
      'employee.manage': ['ORG_ADMIN', 'HR_ADMIN'],
      'integration.manage': ['ORG_ADMIN', 'TECHNICAL_MANAGER'],
      'attendance.admin': ['HR_ADMIN'],
      'audit.view': ['ORG_ADMIN', 'GENERAL_MANAGER'],
      'request.admin': ['ORG_ADMIN', 'HR_ADMIN'],
    });
  });
});
