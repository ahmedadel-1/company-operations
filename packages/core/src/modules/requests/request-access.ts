import type { Prisma } from '@company-ops/db';

import { ForbiddenError, NotFoundError } from '../../platform/errors.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { ActionContext } from '../action-context.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { canAccessResource } from '../authorization/policy.js';
import type { ListScope, Principal, ResourceFacts } from '../authorization/policy.js';
import { holdsOrgWide } from '../projects/project-access.js';

/** Everything an authorization or workflow decision on a request needs. */
export const requestAccessSelect = {
  id: true,
  number: true,
  status: true,
  requestTypeId: true,
  workflowVersionId: true,
  requesterMemberId: true,
  projectId: true,
  version: true,
  route: true,
  currentStepOrder: true,
  formData: true,
  submittedAt: true,
  requester: { select: { profile: { select: { departmentId: true } } } },
  requestType: { select: { key: true, name: true } },
} satisfies Prisma.RequestInstanceSelect;

export type RequestAccessRow = Prisma.RequestInstanceGetPayload<{ select: typeof requestAccessSelect }>;

/** How the caller is involved in the workflow of one request. */
export interface Involvement {
  /** The caller is or was an assigned approver, or decided an approval. */
  readonly participant: boolean;
  /** Pending approvals the caller may decide now: assigned to them, or delegated to them. */
  readonly decidable: readonly { readonly approvalId: string; readonly delegationId: string | null }[];
}

export interface LoadedRequest {
  readonly row: RequestAccessRow;
  readonly facts: ResourceFacts;
  readonly involvement: Involvement;
}

/** Statuses in which fulfillers see a request (approved and later). */
const FULFILMENT_STATUSES: ReadonlySet<string> = new Set(['APPROVED', 'IN_FULFILLMENT', 'COMPLETED']);

/** `REQ-<number>`, the human-readable request key. */
export const requestKey = (number: number): string => `REQ-${String(number)}`;

/**
 * Scope facts of a request (SECURITY §2.1): SELF and TEAM match the requester; DEPARTMENT matches the
 * requester's department; PROJECT matches the project chosen on the form.
 */
export function requestFacts(organizationId: string, row: RequestAccessRow): ResourceFacts {
  const departmentId = row.requester.profile?.departmentId ?? null;
  return {
    organizationId,
    ownerMemberIds: [row.requesterMemberId],
    subjectMemberIds: [row.requesterMemberId],
    departmentIds: departmentId === null ? [] : [departmentId],
    projectIds: row.projectId === null ? [] : [row.projectId],
  };
}

/**
 * Active delegations to `delegateMemberId` at `now`, keyed by delegator. Restricted to delegations that
 * cover `requestTypeId` when given. Delegation is not transitive: only approvals assigned directly to the
 * delegator are covered.
 */
export async function activeDelegationsTo(
  db: TenantDb,
  organizationId: string,
  delegateMemberId: string,
  now: Date,
  requestTypeId?: string,
): Promise<{ delegationId: string; delegatorMemberId: string; requestTypeId: string | null }[]> {
  const rows = await db.approvalDelegation.findMany({
    where: {
      organizationId,
      delegateMemberId,
      revokedAt: null,
      startsAt: { lte: now },
      endsAt: { gt: now },
      ...(requestTypeId === undefined ? {} : { OR: [{ requestTypeId: null }, { requestTypeId }] }),
    },
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    take: 100,
    select: { id: true, delegatorMemberId: true, requestTypeId: true },
  });
  return rows.map((row) => ({
    delegationId: row.id,
    delegatorMemberId: row.delegatorMemberId,
    requestTypeId: row.requestTypeId,
  }));
}

/**
 * Whether a member may act as an approver at all right now: ACTIVE with a sign-in identity, employment
 * ACTIVE or ON_LEAVE (or no profile), holding `request.approve`.
 */
export async function eligibleApprovers(
  db: TenantDb,
  organizationId: string,
  memberIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(memberIds)];
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      id: { in: ids },
      status: 'ACTIVE',
      userId: { not: null },
      OR: [{ profile: { is: null } }, { profile: { is: { employmentStatus: { in: ['ACTIVE', 'ON_LEAVE'] } } } }],
      roles: { some: { role: { permissions: { some: { permissionKey: 'request.approve' } } } } },
    },
    select: { id: true },
  });
  return new Set(rows.map((row) => row.id));
}

async function involvementOf(
  db: TenantDb,
  organizationId: string,
  row: RequestAccessRow,
  memberId: string,
  now: Date,
): Promise<Involvement> {
  const delegations =
    row.status === 'PENDING_APPROVAL'
      ? await activeDelegationsTo(db, organizationId, memberId, now, row.requestTypeId)
      : [];
  const delegators = delegations.map((delegation) => delegation.delegatorMemberId);
  const approvals = await db.requestApproval.findMany({
    where: {
      organizationId,
      requestId: row.id,
      OR: [
        { approverMemberId: memberId },
        { decidedByMemberId: memberId },
        ...(delegators.length === 0 ? [] : [{ status: 'PENDING' as const, approverMemberId: { in: delegators } }]),
      ],
    },
    select: { id: true, approverMemberId: true, decidedByMemberId: true, status: true, stepOrder: true },
    take: 100,
  });
  const participant = approvals.some(
    (approval) => approval.approverMemberId === memberId || approval.decidedByMemberId === memberId,
  );
  // The requester never decides their own request, not even as somebody's delegate.
  const open =
    row.status === 'PENDING_APPROVAL' && row.requesterMemberId !== memberId
      ? approvals.filter((approval) => approval.status === 'PENDING' && approval.stepOrder === row.currentStepOrder)
      : [];
  const decidable = open.flatMap((approval): { approvalId: string; delegationId: string | null }[] => {
    if (approval.approverMemberId === memberId) {
      return [{ approvalId: approval.id, delegationId: null }];
    }
    const delegation = delegations.find((item) => item.delegatorMemberId === approval.approverMemberId);
    return delegation === undefined ? [] : [{ approvalId: approval.id, delegationId: delegation.delegationId }];
  });
  return { participant, decidable };
}

export async function loadRequestForAccess(
  db: TenantDb,
  organizationId: string,
  requestId: string,
  memberId: string,
  now: Date,
): Promise<LoadedRequest | null> {
  const row = await db.requestInstance.findFirst({
    where: { organizationId, id: requestId },
    select: requestAccessSelect,
  });
  if (row === null) {
    return null;
  }
  return {
    row,
    facts: requestFacts(organizationId, row),
    involvement: await involvementOf(db, organizationId, row, memberId, now),
  };
}

/**
 * Visibility (ADR-0021): drafts only to their requester; otherwise the requester, workflow participants
 * (approvers, deciders, delegates of a pending approval) and `request.view` in scope.
 */
export function canViewRequest(principal: Principal, request: LoadedRequest): boolean {
  if (request.facts.organizationId !== principal.organizationId) {
    return false;
  }
  const isRequester = request.row.requesterMemberId === principal.memberId;
  if (request.row.status === 'DRAFT') {
    return isRequester;
  }
  if (
    isRequester &&
    (hasPermission(principal.permissions, 'request.view') || hasPermission(principal.permissions, 'request.create'))
  ) {
    return true;
  }
  if (request.involvement.participant || request.involvement.decidable.length > 0) {
    return true;
  }
  if (FULFILMENT_STATUSES.has(request.row.status) && canAccessResource(principal, 'request.fulfill', request.facts)) {
    return true;
  }
  return canAccessResource(principal, 'request.view', request.facts);
}

/** A request the caller may view; foreign, out-of-scope and other people's drafts are 404. */
export async function loadVisibleRequest(
  db: TenantDb,
  action: ActionContext,
  organizationId: string,
  requestId: string,
  now: Date,
): Promise<LoadedRequest> {
  const request = await loadRequestForAccess(db, organizationId, requestId, action.principal.memberId, now);
  if (request === null || !canViewRequest(action.principal, request)) {
    throw new NotFoundError('Request');
  }
  return request;
}

export function isRequester(action: ActionContext, request: LoadedRequest): boolean {
  return request.row.requesterMemberId === action.principal.memberId;
}

/** Organization-wide request administration (reassignment, cancellation of approved requests). */
export function isRequestAdmin(principal: Principal): boolean {
  return holdsOrgWide(principal, 'request.admin');
}

export function assertRequestAdmin(principal: Principal): void {
  if (!isRequestAdmin(principal)) {
    throw new ForbiddenError();
  }
}

/** Fulfillment is performed by members holding `request.fulfill` on the request. */
export function canFulfil(principal: Principal, request: LoadedRequest): boolean {
  return canAccessResource(principal, 'request.fulfill', request.facts);
}

/**
 * The `request.view` list as a `where` fragment (AND-ed with the organization binding): the caller's own
 * requests, requests they take part in, and requests in scope. Other people's drafts never match.
 */
export function requestScopeWhere(scope: ListScope, memberId: string): Prisma.RequestInstanceWhereInput {
  const notOthersDraft: Prisma.RequestInstanceWhereInput = {
    OR: [{ status: { not: 'DRAFT' } }, { requesterMemberId: memberId }],
  };
  // Prisma matches nothing for an empty object inside `OR`, so organization scope has no OR branch at all.
  if (scope.all) {
    return notOthersDraft;
  }
  const or: Prisma.RequestInstanceWhereInput[] = [
    { requesterMemberId: memberId },
    { approvals: { some: { OR: [{ approverMemberId: memberId }, { decidedByMemberId: memberId }] } } },
  ];
  if (scope.memberIds.length > 0) or.push({ requesterMemberId: { in: [...scope.memberIds] } });
  if (scope.departmentIds.length > 0)
    or.push({ requester: { profile: { is: { departmentId: { in: [...scope.departmentIds] } } } } });
  if (scope.projectIds.length > 0) or.push({ projectId: { in: [...scope.projectIds] } });
  return { AND: [{ OR: or }, notOthersDraft] };
}
