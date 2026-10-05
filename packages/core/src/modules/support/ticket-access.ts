import type { Prisma } from '@company-ops/db';
import type { PermissionKey } from '@company-ops/shared';

import { ForbiddenError, InvalidTransitionError, NotFoundError } from '../../platform/errors.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { canAccessResource } from '../authorization/policy.js';
import type { ListScope, Principal, ResourceFacts } from '../authorization/policy.js';
import { LOCKED_TICKET_STATUSES } from './ticket-state-machine.js';

const departmentSelect = { select: { profile: { select: { departmentId: true } } } } as const;

/** Everything an authorization or workflow decision on a ticket needs. */
export const ticketAccessSelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  severity: true,
  priority: true,
  impact: true,
  source: true,
  projectId: true,
  categoryId: true,
  componentId: true,
  reporterMemberId: true,
  assigneeMemberId: true,
  assignedTeamId: true,
  escalationLevel: true,
  version: true,
  slaPolicyId: true,
  slaStartedAt: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  firstRespondedAt: true,
  resolvedAt: true,
  slaPausedSince: true,
  slaPausedTotalSeconds: true,
  firstResponseSlaState: true,
  resolutionSlaState: true,
  reporter: departmentSelect,
  assignee: departmentSelect,
  project: {
    select: {
      code: true,
      name: true,
      status: true,
      timeZone: true,
      projectManager: { select: { memberId: true } },
      technicalManager: { select: { memberId: true } },
    },
  },
} satisfies Prisma.SupportTicketSelect;

export type TicketAccessRow = Prisma.SupportTicketGetPayload<{ select: typeof ticketAccessSelect }>;

export interface LoadedTicket {
  readonly row: TicketAccessRow;
  readonly facts: ResourceFacts;
}

/** `SUP-<number>`, the human-readable ticket key. */
export const ticketKey = (number: number): string => `SUP-${String(number)}`;

/**
 * Scope facts of a ticket (SECURITY §2.1): SELF and TEAM match its reporter and assignee;
 * DEPARTMENT matches their departments; PROJECT matches its project. `withoutAssignee` evaluates
 * the ticket as if it were unassigned (assignment eligibility must not be self-justifying).
 */
export function ticketFacts(organizationId: string, row: TicketAccessRow, withoutAssignee = false): ResourceFacts {
  const members = [row.reporterMemberId];
  const departments = [row.reporter.profile?.departmentId ?? null];
  if (!withoutAssignee && row.assigneeMemberId !== null) {
    members.push(row.assigneeMemberId);
    departments.push(row.assignee?.profile?.departmentId ?? null);
  }
  return {
    organizationId,
    ownerMemberIds: [...new Set(members)],
    subjectMemberIds: [...new Set(members)],
    departmentIds: [...new Set(departments.filter((id): id is string => id !== null))],
    projectIds: row.projectId === null ? [] : [row.projectId],
  };
}

export async function loadTicketForAccess(
  db: TenantDb,
  organizationId: string,
  ticketId: string,
): Promise<LoadedTicket | null> {
  const row = await db.supportTicket.findFirst({ where: { organizationId, id: ticketId }, select: ticketAccessSelect });
  return row === null ? null : { row, facts: ticketFacts(organizationId, row) };
}

/** A ticket the caller may view (`support.view` in scope); foreign or out-of-scope tickets are 404. */
export async function loadVisibleTicket(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  ticketId: string,
): Promise<LoadedTicket> {
  const ticket = await loadTicketForAccess(db, organizationId, ticketId);
  if (ticket === null || !holdsOnTicket(action.principal, 'support.view', ticket)) {
    throw new NotFoundError('Ticket');
  }
  return ticket;
}

/**
 * Permissions a reporter exercises on their own ticket. Held at any scope, they also cover the
 * member's own tickets (SECURITY §2.5: reporters always see and follow up on what they reported), so a
 * field employee with PROJECT-scoped grants keeps access to a ticket filed without a project.
 */
const REPORTER_PERMISSIONS: readonly PermissionKey[] = ['support.view', 'support.comment', 'support.verify'];

export function holdsOnTicket(
  principal: Principal,
  permission: PermissionKey,
  ticket: Pick<LoadedTicket, 'row' | 'facts'>,
): boolean {
  if (canAccessResource(principal, permission, ticket.facts)) {
    return true;
  }
  return (
    REPORTER_PERMISSIONS.includes(permission) &&
    ticket.facts.organizationId === principal.organizationId &&
    ticket.row.reporterMemberId === principal.memberId &&
    hasPermission(principal.permissions, permission)
  );
}

/** The member whose own reported tickets widen a `support.view` list (see `REPORTER_PERMISSIONS`). */
export function reporterScopeOf(principal: Principal): string | null {
  return hasPermission(principal.permissions, 'support.view') ? principal.memberId : null;
}

/** Visible but not permitted is 403 (SECURITY §2.2). */
export function assertTicketPermission(action: ActionContext, permission: PermissionKey, ticket: LoadedTicket): void {
  if (!holdsOnTicket(action.principal, permission, ticket)) {
    throw new ForbiddenError();
  }
}

/** Closed and cancelled tickets are read-only history until reopened. */
export function assertTicketUnlocked(ticket: LoadedTicket): void {
  if (LOCKED_TICKET_STATUSES.includes(ticket.row.status)) {
    throw new InvalidTransitionError('The ticket is closed or cancelled; reopen it before making changes.');
  }
}

/**
 * The `support.view` list scope as a `where` fragment (AND-ed with the organization binding by the
 * caller), widened by the tickets `reporterMemberId` reported. `null` = no restriction; `'none'` = no
 * row can match.
 */
export function ticketScopeWhere(
  scope: ListScope,
  reporterMemberId: string | null,
): Prisma.SupportTicketWhereInput | null | 'none' {
  if (scope.all) {
    return null;
  }
  const or: Prisma.SupportTicketWhereInput[] = [];
  if (reporterMemberId !== null) {
    or.push({ reporterMemberId });
  }
  if (scope.memberIds.length > 0) {
    const memberIds = [...scope.memberIds];
    or.push({ reporterMemberId: { in: memberIds } }, { assigneeMemberId: { in: memberIds } });
  }
  if (scope.departmentIds.length > 0) {
    const departmentIds = [...scope.departmentIds];
    or.push(
      { reporter: { profile: { is: { departmentId: { in: departmentIds } } } } },
      { assignee: { is: { profile: { is: { departmentId: { in: departmentIds } } } } } },
    );
  }
  if (scope.projectIds.length > 0) {
    or.push({ projectId: { in: [...scope.projectIds] } });
  }
  return or.length === 0 ? 'none' : { OR: or };
}
