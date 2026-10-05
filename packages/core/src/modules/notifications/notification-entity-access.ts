import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { loadMemberAccess } from '../authorization/member-access.js';
import { canAccessResource } from '../authorization/policy.js';
import {
  canViewCorporate,
  corporateAccessSelect,
  corporateFacts,
  loadContractForAccess,
  loadTenderForAccess,
} from '../commercial/commercial-access.js';
import { canViewRequest, loadRequestForAccess } from '../requests/request-access.js';
import { holdsOnTicket, loadTicketForAccess } from '../support/ticket-access.js';

/**
 * Whether a member may still open the subject of a notification, evaluated against current grants
 * and the subject's current state. Used right before an email is sent, so a delivery queued while the
 * recipient had access is suppressed once that access is gone.
 */
export type NotificationEntityAccess = (
  organizationId: string,
  memberId: string,
  entityType: string | null,
  entityId: string | null,
) => Promise<boolean>;

/**
 * Support tickets are re-checked with the same `support.view` rule that selected the recipients; a
 * deleted ticket is not visible. Requests use the request visibility rule (requester, participants,
 * delegates of pending approvals, scope); delegation notices go to the two parties only. Jira connection and GitHub installation notices go to integration
 * administrators only, so
 * `integration.manage` at organization scope is re-checked. Tenders and contracts use their
 * visibility rule (FULL or INVOLVED); corporate documents their scope and classification rule. Other subjects carry no entity-specific
 * content in their emails (the link leads to an authorized page), so the active-membership check
 * already applied suffices.
 */
export function notificationEntityAccess(db: TenantDb): NotificationEntityAccess {
  return async (organizationId, memberId, entityType, entityId) => {
    if (entityType === 'jira_connection' || entityType === 'github_installation') {
      const member = (await loadMemberAccess(db, organizationId, [memberId])).get(memberId);
      return member !== undefined && canAccessResource(member.principal, 'integration.manage', { organizationId });
    }
    if (entityType === 'request' && entityId !== null) {
      const member = (await loadMemberAccess(db, organizationId, [memberId])).get(memberId);
      if (member === undefined) {
        return false;
      }
      const request = await loadRequestForAccess(db, organizationId, entityId, memberId, new Date());
      return request !== null && canViewRequest(member.principal, request);
    }
    if (entityType === 'approval_delegation' && entityId !== null) {
      const delegation = await db.approvalDelegation.findFirst({
        where: { organizationId, id: entityId, OR: [{ delegatorMemberId: memberId }, { delegateMemberId: memberId }] },
        select: { id: true },
      });
      return delegation !== null;
    }
    if (
      (entityType === 'tender' || entityType === 'contract' || entityType === 'corporate_document') &&
      entityId !== null
    ) {
      const member = (await loadMemberAccess(db, organizationId, [memberId])).get(memberId);
      if (member === undefined) {
        return false;
      }
      if (entityType === 'tender') {
        return (await loadTenderForAccess(db, member.principal, organizationId, entityId)) !== null;
      }
      if (entityType === 'contract') {
        return (await loadContractForAccess(db, member.principal, organizationId, entityId)) !== null;
      }
      const document = await db.corporateDocument.findFirst({
        where: { organizationId, id: entityId },
        select: corporateAccessSelect,
      });
      return (
        document !== null &&
        canViewCorporate(member.principal, corporateFacts(organizationId, document), document.classification)
      );
    }
    if (entityType !== 'support_ticket' || entityId === null) {
      return true;
    }
    const ticket = await loadTicketForAccess(db, organizationId, entityId);
    if (ticket === null) {
      return false;
    }
    const member = (await loadMemberAccess(db, organizationId, [memberId])).get(memberId);
    return member !== undefined && holdsOnTicket(member.principal, 'support.view', ticket);
  };
}
