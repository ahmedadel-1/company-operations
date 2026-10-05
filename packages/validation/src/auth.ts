import { z } from 'zod';

const scopeSchema = z.enum(['SELF', 'TEAM', 'DEPARTMENT', 'PROJECT', 'ORG']);

/**
 * Post-login redirect target. Only same-origin absolute paths are accepted (no scheme, no
 * protocol-relative `//host`, no backslashes or control characters), which prevents open redirects.
 */
export const returnToPathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?![/\\])[^\\\s\p{Cc}]*$/u, 'must be a same-origin absolute path');

export const loginQuerySchema = z.strictObject({
  returnTo: returnToPathSchema.optional(),
});

/** Single-use invitation token from an invitation link (32 random bytes, base64url). */
export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'malformed invitation token');

export const signInQuerySchema = loginQuerySchema.extend({
  invitation: invitationTokenSchema.optional(),
});

/** Body of `PUT /api/v1/me/active-organization`. The target is validated against the user's memberships. */
export const switchOrganizationRequestSchema = z.strictObject({
  organizationId: z.uuid(),
});

/**
 * Form body Keycloak posts to `/api/v1/auth/backchannel-logout`. Not strict: the OIDC spec allows
 * additional parameters. The token itself is verified cryptographically.
 */
export const backchannelLogoutRequestSchema = z.object({
  logout_token: z.string().min(1).max(8192),
});

export const csrfTokenResponseSchema = z.strictObject({
  data: z.strictObject({ csrfToken: z.string().min(32) }),
});

export const switchOrganizationResponseSchema = z.strictObject({
  data: z.strictObject({ organizationId: z.uuid(), csrfToken: z.string().min(32) }),
});

export const logoutResponseSchema = z.strictObject({
  data: z.strictObject({ logoutUrl: z.url() }),
});

export const meResponseSchema = z.strictObject({
  data: z.strictObject({
    user: z.strictObject({
      id: z.uuid(),
      displayName: z.string(),
      email: z.string().nullable(),
    }),
    activeOrganization: z.strictObject({
      id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      /** The caller's own membership id in the active organization. */
      memberId: z.uuid(),
    }),
    memberships: z.array(
      z.strictObject({
        organizationId: z.uuid(),
        slug: z.string(),
        name: z.string(),
        active: z.boolean(),
      }),
    ),
    /** UX only; the API re-checks every permission (SECURITY §2.2). */
    permissions: z.array(z.strictObject({ key: z.string(), scopes: z.array(scopeSchema) })),
    mfa: z.strictObject({
      /** True when the session's authentication level satisfies privileged endpoints right now. */
      satisfied: z.boolean(),
      acr: z.string().nullable(),
    }),
  }),
});

export type LoginQuery = z.infer<typeof loginQuerySchema>;
export type SignInQuery = z.infer<typeof signInQuerySchema>;
export type BackchannelLogoutRequest = z.infer<typeof backchannelLogoutRequestSchema>;
export type SwitchOrganizationRequest = z.infer<typeof switchOrganizationRequestSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
