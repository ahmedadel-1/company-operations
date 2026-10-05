import type { PermissionKey, Scope } from './permissions.js';

/**
 * System role templates: the V1 least-privilege baseline (SECURITY §2.5). Materialized into every
 * organization's `roles` / `role_permissions` at creation (ADR-0012); afterwards each organization
 * owns its copy. SUPER_ADMIN is a platform role and deliberately absent (ADR-0010).
 */
export const SYSTEM_ROLE_KEYS = [
  'ORG_ADMIN',
  'GENERAL_MANAGER',
  'TECHNICAL_MANAGER',
  'DEPARTMENT_MANAGER',
  'PROJECT_MANAGER',
  'TEAM_LEAD',
  'HR_ADMIN',
  'SUPPORT_AGENT',
  'FIELD_EMPLOYEE',
  'EMPLOYEE',
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const SYSTEM_ROLE_NAMES: Readonly<Record<SystemRoleKey, string>> = {
  ORG_ADMIN: 'Organization admin',
  GENERAL_MANAGER: 'General manager',
  TECHNICAL_MANAGER: 'Technical manager',
  DEPARTMENT_MANAGER: 'Department manager',
  PROJECT_MANAGER: 'Project manager',
  TEAM_LEAD: 'Team lead',
  HR_ADMIN: 'HR admin',
  SUPPORT_AGENT: 'Support agent',
  FIELD_EMPLOYEE: 'Field employee',
  EMPLOYEE: 'Employee',
};

/** Holders of this role need MFA at login (SECURITY §2.3, §3.2). */
export const MFA_AT_LOGIN_ROLE_KEYS: readonly SystemRoleKey[] = ['ORG_ADMIN'];

/**
 * Matrix cells in SECURITY §2.5 column order (OA, GM, TM, DM, PM, TL, HR, SA, FE, EMP):
 * O = ORG, D = DEPARTMENT, P = PROJECT, T = TEAM, S = SELF, '' = not granted.
 * '+' is the matrix "✓" (granted; the effective target is defined by the permission's own rule, e.g.
 * request.approve still needs a pending approval row). It is stored with scope SELF.
 */
type Cell = '' | 'O' | 'D' | 'P' | 'T' | 'S' | '+';
type Row = readonly [Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell, Cell];

const ALL: Row = ['+', '+', '+', '+', '+', '+', '+', '+', '+', '+'];

const BASELINE_MATRIX: Readonly<Record<PermissionKey, Row>> = {
  'org.settings.manage': ['O', '', '', '', '', '', '', '', '', ''],
  'role.manage': ['O', '', '', '', '', '', '', '', '', ''],
  'employee.view': ['O', 'O', 'O', 'O', 'O', 'O', 'O', 'O', 'O', 'O'],
  'employee.view_contact': ['O', 'O', 'O', 'D', 'P', 'T', 'O', '', '', ''],
  'employee.manage': ['O', '', '', '', '', '', 'O', '', '', ''],
  'department.manage': ['O', '', '', '', '', '', 'O', '', '', ''],
  'project.view': ['O', 'O', 'O', 'D', 'P', 'P', '', 'O', 'P', 'P'],
  'project.create': ['O', '', 'O', '', '', '', '', '', '', ''],
  'project.manage': ['O', '', 'O', '', 'P', '', '', '', '', ''],
  'project.assign_members': ['O', '', 'O', '', 'P', '', '', '', '', ''],
  'daily_report.submit': ['', '', '', '', 'P', 'P', '', '', 'P', ''],
  'daily_report.view': ['', 'O', 'O', 'D', 'P', 'P', '', 'O', 'P', ''],
  'support.view': ['S', 'O', 'O', 'D', 'P', 'P', 'S', 'O', 'P', 'S'],
  'support.create': ALL,
  'support.comment': ['S', '', 'O', 'D', 'P', 'P', 'S', 'O', 'P', 'S'],
  'support.internal_note': ['', '', 'O', '', 'P', 'P', '', 'O', '', ''],
  'support.triage': ['', '', 'O', '', 'P', '', '', 'O', '', ''],
  'support.assign': ['', '', 'O', '', 'P', 'P', '', 'O', '', ''],
  'support.escalate': ['', '', 'O', '', 'P', 'P', '', 'O', '', ''],
  'support.resolve': ['', '', 'O', '', '', 'P', '', 'O', '', ''],
  'support.verify': ['S', '', 'O', '', 'P', '', 'S', 'O', 'P', 'S'],
  'support.close': ['', '', 'O', '', 'P', '', '', 'O', '', ''],
  'support.config': ['O', '', 'O', '', '', '', '', '', '', ''],
  'jira.view': ['O', 'O', 'O', 'D', 'P', 'P', '', 'O', '', ''],
  'jira.link': ['', '', 'O', '', 'P', 'P', '', 'O', '', ''],
  'jira.create_issue': ['', '', 'O', '', 'P', 'P', '', 'O', '', ''],
  'github.view': ['O', 'O', 'O', 'D', 'P', 'P', '', '', '', ''],
  'github.link': ['', '', 'O', '', 'P', 'P', '', '', '', ''],
  'integration.manage': ['O', '', 'O', '', '', '', '', '', '', ''],
  'request.create': ALL,
  'request.view': ['O', 'O', 'T', 'D', 'P', 'T', 'O', 'S', 'S', 'S'],
  'request.approve': ALL,
  'request.fulfill': ['O', '', '', '', '', '', 'O', '', '', ''],
  'request.admin': ['O', '', '', '', '', '', 'O', '', '', ''],
  'attendance.self': ALL,
  'attendance.team': ['', 'O', 'T', 'D', 'P', 'T', 'O', '', '', ''],
  'attendance.config': ['O', '', '', '', '', '', 'O', '', '', ''],
  'attendance.admin': ['', '', '', '', '', '', 'O', '', '', ''],
  'dashboard.project': ['', 'O', 'O', 'D', 'P', '', '', '', '', ''],
  'dashboard.executive': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'notification.config': ['O', '', '', '', '', '', '', '', '', ''],
  'audit.view': ['O', 'O', '', '', '', '', '', '', '', ''],
  'tender.view': ['O', 'O', 'O', 'S', 'P', '', '', '', '', ''],
  'tender.create': ['', 'O', 'O', '', 'P', '', '', '', '', ''],
  'tender.edit': ['', 'O', 'O', 'S', 'P', '', '', '', '', ''],
  'tender.delete_draft': ['', 'O', 'O', '', 'P', '', '', '', '', ''],
  'tender.manage_requirements': ['', 'O', 'O', 'S', 'P', '', '', '', '', ''],
  'tender.review': ['', '+', '+', '+', '+', '+', '', '', '', ''],
  'tender.approve': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'tender.submit': ['', 'O', 'O', 'S', 'P', '', '', '', '', ''],
  'tender.record_award': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'tender.record_loss': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'tender.financial.view': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'contract.view': ['O', 'O', 'O', '', 'P', '', '', '', '', ''],
  'contract.create': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'contract.edit': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'contract.approve': ['', 'O', '', '', '', '', '', '', '', ''],
  'contract.manage_documents': ['', 'O', 'O', '', 'P', '', '', '', '', ''],
  'contract.manage_obligations': ['', 'O', 'O', '', 'P', '', '', '', '', ''],
  'contract.manage_milestones': ['', 'O', 'O', '', 'P', '', '', '', '', ''],
  'contract.manage_guarantees': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'contract.manage_amendments': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'contract.manage_renewal': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'contract.financial.view': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'corporate_document.view': ['O', 'O', 'O', 'O', 'O', 'O', 'O', '', '', ''],
  'corporate_document.manage': ['O', 'O', 'O', '', '', '', 'O', '', '', ''],
  'corporate_document.restricted.view': ['', 'O', 'O', '', '', '', '', '', '', ''],
  'commercial_document.view': ['', 'O', 'O', '', '', '', '', '', '', ''],
};

const CELL_SCOPE: Readonly<Record<Exclude<Cell, ''>, Scope>> = {
  O: 'ORG',
  D: 'DEPARTMENT',
  P: 'PROJECT',
  T: 'TEAM',
  S: 'SELF',
  '+': 'SELF',
};

export interface PermissionGrant {
  readonly permission: PermissionKey;
  readonly scope: Scope;
}

export interface SystemRoleTemplate {
  readonly key: SystemRoleKey;
  readonly name: string;
  readonly grants: readonly PermissionGrant[];
}

function buildTemplates(): Readonly<Record<SystemRoleKey, SystemRoleTemplate>> {
  const entries = SYSTEM_ROLE_KEYS.map((key, column): [SystemRoleKey, SystemRoleTemplate] => {
    const grants: PermissionGrant[] = [];
    for (const [permission, row] of Object.entries(BASELINE_MATRIX) as [PermissionKey, Row][]) {
      const cell = row[column];
      if (cell !== undefined && cell !== '') {
        grants.push({ permission, scope: CELL_SCOPE[cell] });
      }
    }
    return [key, { key, name: SYSTEM_ROLE_NAMES[key], grants }];
  });
  return Object.fromEntries(entries) as Record<SystemRoleKey, SystemRoleTemplate>;
}

export const SYSTEM_ROLE_TEMPLATES: Readonly<Record<SystemRoleKey, SystemRoleTemplate>> = buildTemplates();
