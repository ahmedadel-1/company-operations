# ADR-0010: SUPER_ADMIN is a platform-level role, not a tenant super-user

Date: 2026-10-02 · Status: Accepted

## Context
The master spec lists `SUPER_ADMIN` among example roles. Interpreted as "a member who can see everything in every organization", it would contradict the tenant-isolation requirement and create an invisible cross-tenant bypass.

## Decision
1. `SUPER_ADMIN` is stored on the global `users.platform_role` column. It is **not** an organization role and is **not** equivalent to `ORG_ADMIN`. A super admin has no tenant data access by virtue of the role.
2. Platform endpoints (`/api/v1/platform/*`, deferred until needed) cover platform operations only: create/suspend organizations, view platform health, manage platform settings. They return organization metadata, not tenant business data.
3. **Normal requests always execute inside an explicit tenant context.** A super admin who is also a member of an organization acts there with that membership's roles only.
4. **No implicit bypass.** There is no code path where `platform_role` widens tenant queries. The Prisma guard extension and tenant-scoped repositories apply identically to super admins.
5. **Support access (deferred, boundary defined now).** If cross-tenant support access is required later, it must be implemented as an explicit `support_access_sessions` record: requested by a super admin with a reason, optionally approved by the target org's `ORG_ADMIN`, time-boxed (default ≤ 60 min), read-only by default, visibly bannered in the UI, and fully audited (start, every request, end) in both the platform audit log and the target organization's audit log.
6. MFA is mandatory for super admins (ADR-0002, `SECURITY.md` §2).
7. Platform-level actions are recorded in a separate `platform_audit_logs` table so `audit_logs.organization_id` stays non-null.

## Consequences
- Tenant isolation has no special cases.
- Phase 1 needs no impersonation mechanism; operators create the first organization via a CLI/bootstrap command (`packages/db` script) audited to `platform_audit_logs`.
