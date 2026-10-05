# ADR-0012: Global identity, organization membership, per-org roles and a code-defined permission catalog

Date: 2026-10-02 · Status: Accepted

## Context
The spec's expected entity list includes `users`, `employee_profiles`, `roles`, `permissions`, `user_roles`. Requirements: SaaS-ready multi-tenancy (one human may later belong to several organizations), RBAC plus contextual scope, centralized permission definitions, no authorization drift between catalog and enforcement.

## Decision
1. **`users`** is the global identity record keyed by `(idp_issuer, idp_subject)` — never by email. It is the only business table without `organization_id` (besides platform tables).
2. **`organization_members`** links a user to an organization. All tenant data references the **member**, not the user. `employee_profiles` is 1:1 with a member.
3. **Roles are tenant-owned.** System role templates are defined in code (`packages/shared`) and **materialized per organization** at organization creation (`roles.organization_id` is never null). Orgs may later clone/customize roles (Phase 9 UI).
4. **Permissions are code-defined** in `packages/shared/src/permissions.ts` (no `permissions` table). `role_permissions(role_id, permission_key, scope)` validates `permission_key` against the catalog.
5. `user_roles` from the spec is realized as **`member_roles`** (role grants are per organization membership).

## Consequences
- Per-org role customization without cross-tenant shared rows.
- Adding a permission is a code change reviewed alongside its enforcement.
- Differs from the spec's suggested table names (`permissions`, `user_roles`); the spec's intent (centralized permissions, RBAC) is preserved.
