/**
 * Code-defined permission catalog (SECURITY §2.4, ADR-0012). There is no permissions table:
 * `role_permissions.permission_key` is validated against this list, so catalog and enforcement
 * cannot drift. Adding a key requires updating SECURITY §2.4 and the §2.5 baseline.
 */
export const PERMISSION_KEYS = [
  'org.settings.manage',
  'role.manage',
  'employee.view',
  'employee.view_contact',
  'employee.manage',
  'department.manage',
  'project.view',
  'project.create',
  'project.manage',
  'project.assign_members',
  'daily_report.submit',
  'daily_report.view',
  'support.view',
  'support.create',
  'support.comment',
  'support.internal_note',
  'support.triage',
  'support.assign',
  'support.escalate',
  'support.resolve',
  'support.verify',
  'support.close',
  'support.config',
  'jira.view',
  'jira.link',
  'jira.create_issue',
  'github.view',
  'github.link',
  'integration.manage',
  'request.create',
  'request.view',
  'request.approve',
  'request.fulfill',
  'request.admin',
  'attendance.self',
  'attendance.team',
  'attendance.config',
  'attendance.admin',
  'dashboard.project',
  'dashboard.executive',
  'notification.config',
  'audit.view',
  'tender.view',
  'tender.create',
  'tender.edit',
  'tender.delete_draft',
  'tender.manage_requirements',
  'tender.review',
  'tender.approve',
  'tender.submit',
  'tender.record_award',
  'tender.record_loss',
  'tender.financial.view',
  'contract.view',
  'contract.create',
  'contract.edit',
  'contract.approve',
  'contract.manage_documents',
  'contract.manage_obligations',
  'contract.manage_milestones',
  'contract.manage_guarantees',
  'contract.manage_amendments',
  'contract.manage_renewal',
  'contract.financial.view',
  'corporate_document.view',
  'corporate_document.manage',
  'corporate_document.restricted.view',
  'commercial_document.view',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const permissionKeySet: ReadonlySet<string> = new Set(PERMISSION_KEYS);

export function isPermissionKey(value: string): value is PermissionKey {
  return permissionKeySet.has(value);
}

/** Breadth of a grant (SECURITY §2.1). Each grant is evaluated independently; any match allows. */
export const SCOPES = ['SELF', 'TEAM', 'DEPARTMENT', 'PROJECT', 'ORG'] as const;

export type Scope = (typeof SCOPES)[number];

const scopeSet: ReadonlySet<string> = new Set(SCOPES);

export function isScope(value: string): value is Scope {
  return scopeSet.has(value);
}

/**
 * Permissions whose use requires a multi-factor authentication (SECURITY §2.3, `MfaGuard`).
 * ORG_ADMIN holders additionally need MFA at login.
 */
export const PRIVILEGED_PERMISSIONS: readonly PermissionKey[] = [
  'integration.manage',
  'role.manage',
  'org.settings.manage',
  'employee.manage',
  'attendance.admin',
  'audit.view',
  'request.admin',
];

const privilegedSet: ReadonlySet<PermissionKey> = new Set(PRIVILEGED_PERMISSIONS);

export function isPrivilegedPermission(permission: PermissionKey): boolean {
  return privilegedSet.has(permission);
}

/**
 * Commercially sensitive permissions (SECURITY §2.6, ADR-0026): contract and tender money, confidential
 * tender/contract documents and restricted corporate documents. A role manager who is not an ORG_ADMIN
 * holder may grant a role carrying one of these, or add one to a role, only when holding it at ORG scope.
 */
export const SENSITIVE_COMMERCIAL_PERMISSIONS: readonly PermissionKey[] = [
  'tender.financial.view',
  'contract.financial.view',
  'commercial_document.view',
  'corporate_document.restricted.view',
];

const sensitiveCommercialSet: ReadonlySet<PermissionKey> = new Set(SENSITIVE_COMMERCIAL_PERMISSIONS);

export function isSensitiveCommercialPermission(permission: string): boolean {
  return sensitiveCommercialSet.has(permission as PermissionKey);
}
