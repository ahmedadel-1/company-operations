import { z } from 'zod';

import { dataResponseSchema, isoDateTimeSchema, listResponseSchema } from './pagination.js';

const scopeSchema = z.enum(['SELF', 'TEAM', 'DEPARTMENT', 'PROJECT', 'ORG']);

export const roleSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  /** ORG_ADMIN or carries `role.manage`: only organization admins may grant or revoke it. */
  administratorEquivalent: z.boolean(),
  permissions: z.array(z.strictObject({ key: z.string(), scope: scopeSchema })),
});

export const roleListResponseSchema = listResponseSchema(roleSchema);

export const memberRoleSchema = z.strictObject({
  roleId: z.uuid(),
  key: z.string(),
  name: z.string(),
  grantedAt: isoDateTimeSchema,
  grantedByMemberId: z.uuid().nullable(),
});

export const memberRoleListResponseSchema = listResponseSchema(memberRoleSchema);

export const memberParamsSchema = z.strictObject({ memberId: z.uuid() });
export const memberRoleParamsSchema = z.strictObject({ memberId: z.uuid(), roleId: z.uuid() });
export const grantRoleRequestSchema = z.strictObject({ roleId: z.uuid() });
export const grantRoleResponseSchema = dataResponseSchema(z.strictObject({ created: z.boolean() }));

export const roleResponseSchema = dataResponseSchema(roleSchema);
export const roleParamsSchema = z.strictObject({ roleId: z.uuid() });

const roleNameSchema = z.string().trim().min(1).max(80);
/** Catalog membership of each key is checked by the service (the catalog lives in @company-ops/shared). */
const roleGrantsSchema = z
  .array(z.strictObject({ key: z.string().regex(/^[a-z][a-z_.]{1,63}$/), scope: scopeSchema }))
  .max(250);

export const createRoleRequestSchema = z.strictObject({ name: roleNameSchema, permissions: roleGrantsSchema });
export const updateRoleRequestSchema = z
  .strictObject({ name: roleNameSchema.optional(), permissions: roleGrantsSchema.optional() })
  .refine((value) => value.name !== undefined || value.permissions !== undefined, 'name or permissions is required');

export type Role = z.infer<typeof roleSchema>;
export type RoleParams = z.infer<typeof roleParamsSchema>;
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;
export type MemberRole = z.infer<typeof memberRoleSchema>;
export type MemberParams = z.infer<typeof memberParamsSchema>;
export type MemberRoleParams = z.infer<typeof memberRoleParamsSchema>;
export type GrantRoleRequest = z.infer<typeof grantRoleRequestSchema>;
