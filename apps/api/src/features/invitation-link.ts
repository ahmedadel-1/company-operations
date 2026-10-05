import type { IssuedInvitation } from '@company-ops/core';
import type { Invitation } from '@company-ops/validation';

/** The sign-in link that redeems an invitation; the token is shown once and only its hash is stored. */
export function invitationLink(publicUrl: string, invitation: IssuedInvitation): Invitation {
  return {
    url: `${publicUrl}/api/v1/auth/login?invitation=${encodeURIComponent(invitation.token)}`,
    expiresAt: invitation.expiresAt,
  };
}
