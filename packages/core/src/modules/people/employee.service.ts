import { EmploymentType, MemberStatus } from '@company-ops/db';
import type { EmploymentStatus, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { escapeLike } from '../../platform/db/like.js';
import { nextCounterValue } from '../../platform/db/sql/counters.js';
import { lockOrganizationForAdminChange, lockOrganizationHierarchy } from '../../platform/db/sql/locks.js';
import { isInReportingSubtree } from '../../platform/db/sql/org-hierarchy.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
} from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { assertNotLastAdministrator } from '../access/administrators.js';
import { canAccessResource, isEmptyListScope, listScope } from '../authorization/policy.js';
import type { ListScope, Principal, ResourceFacts } from '../authorization/policy.js';
import { generateInvitationToken, hashInvitationToken, INVITATION_TTL_MS } from './invitation-token.js';

export interface EmployeeView {
  readonly id: string;
  readonly memberId: string;
  readonly employeeNumber: string;
  readonly fullName: string;
  readonly workEmail: string | null;
  /** Null unless the caller may see contact fields (`employee.view_contact` in scope, or self). */
  readonly phone: string | null;
  readonly contactVisible: boolean;
  readonly department: { readonly id: string; readonly name: string } | null;
  readonly jobTitle: { readonly id: string; readonly name: string } | null;
  readonly manager: { readonly id: string; readonly fullName: string } | null;
  readonly employmentStatus: EmploymentStatus;
  readonly employmentType: EmploymentType;
  /** ISO date (YYYY-MM-DD). */
  readonly joinDate: string | null;
  readonly memberStatus: MemberStatus;
  readonly hasAvatar: boolean;
  readonly timeZone: string | null;
  readonly locale: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EmployeeListFilter {
  readonly q?: string | undefined;
  readonly departmentId?: string | undefined;
  readonly teamId?: string | undefined;
  readonly managerId?: string | undefined;
  readonly employmentStatus?: EmploymentStatus | undefined;
  readonly memberStatus?: MemberStatus | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface NewEmployee {
  readonly fullName: string;
  readonly employeeNumber?: string | undefined;
  readonly workEmail?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly departmentId?: string | null | undefined;
  readonly jobTitleId?: string | null | undefined;
  readonly managerId?: string | null | undefined;
  readonly employmentType?: EmploymentType | undefined;
  readonly joinDate?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
  readonly locale?: 'en' | 'ar' | null | undefined;
}

export interface EmployeeChanges {
  readonly fullName?: string | undefined;
  readonly employeeNumber?: string | undefined;
  readonly workEmail?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly departmentId?: string | null | undefined;
  readonly jobTitleId?: string | null | undefined;
  readonly managerId?: string | null | undefined;
  readonly employmentStatus?: EmploymentStatus | undefined;
  readonly employmentType?: EmploymentType | undefined;
  readonly joinDate?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
  readonly locale?: 'en' | 'ar' | null | undefined;
}

/** Fields a member may change on their own profile without `employee.manage`. */
export interface OwnProfileChanges {
  readonly phone?: string | null | undefined;
  readonly timeZone?: string | null | undefined;
  readonly locale?: 'en' | 'ar' | null | undefined;
}

export interface IssuedInvitation {
  readonly token: string;
  readonly expiresAt: string;
}

const employeeSelect = {
  id: true,
  memberId: true,
  employeeNumber: true,
  fullName: true,
  workEmail: true,
  phone: true,
  departmentId: true,
  employmentStatus: true,
  employmentType: true,
  joinDate: true,
  avatarAttachmentId: true,
  timeZone: true,
  locale: true,
  createdAt: true,
  updatedAt: true,
  department: { select: { id: true, name: true } },
  jobTitle: { select: { id: true, name: true } },
  manager: { select: { id: true, fullName: true } },
  member: { select: { status: true } },
} satisfies Prisma.EmployeeProfileSelect;

type EmployeeRow = Prisma.EmployeeProfileGetPayload<{ select: typeof employeeSelect }>;

/** Scope facts of an employee (SECURITY §2.1): the member it is, and its department. */
export function employeeFacts(
  organizationId: string,
  row: { memberId: string; departmentId: string | null },
): ResourceFacts {
  return {
    organizationId,
    ownerMemberIds: [row.memberId],
    subjectMemberIds: [row.memberId],
    departmentIds: row.departmentId === null ? [] : [row.departmentId],
  };
}

/** The `employee.view` list scope as a profile `where` fragment; null = no restriction. */
export function employeeScopeWhere(scope: ListScope): Prisma.EmployeeProfileWhereInput | null {
  if (scope.all) {
    return null;
  }
  const or: Prisma.EmployeeProfileWhereInput[] = [];
  if (scope.memberIds.length > 0) {
    or.push({ memberId: { in: [...scope.memberIds] } });
  }
  if (scope.departmentIds.length > 0) {
    or.push({ departmentId: { in: [...scope.departmentIds] } });
  }
  return { OR: or };
}

/**
 * Text match on name and employee number; the work email only for callers who may see every
 * employee's contact fields (otherwise a search would confirm a hidden address).
 */
export function employeeTextMatch(principal: Principal, text: string): Prisma.EmployeeProfileWhereInput[] {
  const q = escapeLike(text);
  return [
    { fullName: { contains: q, mode: 'insensitive' } },
    { employeeNumber: { contains: q, mode: 'insensitive' } },
    ...(canAccessResource(principal, 'employee.view_contact', { organizationId: principal.organizationId })
      ? [{ workEmail: { contains: q, mode: 'insensitive' as const } }]
      : []),
  ];
}

const MAX_EMPLOYEE_NUMBER_ATTEMPTS = 1000;

const toDateOnly = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));
const fromDateOnly = (value: string | null): Date | null =>
  value === null ? null : new Date(`${value}T00:00:00.000Z`);

/**
 * Employees of the active organization (P1-12). Reads are filtered by the `employee.view` scope
 * (out-of-scope ids are 404); changes need `employee.manage` in scope for both the current and the
 * resulting department (403 when visible but not manageable). Every change is audited.
 */
export class EmployeeService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, filter: EmployeeListFilter): Promise<Page<EmployeeView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const scope = listScope(action.principal, 'employee.view');
    const size = pageSize(filter.limit);
    if (isEmptyListScope(scope)) {
      return { items: [], nextCursor: null };
    }
    const and: Prisma.EmployeeProfileWhereInput[] = [];
    const scopeWhere = employeeScopeWhere(scope);
    if (scopeWhere !== null) {
      and.push(scopeWhere);
    }
    if (filter.q !== undefined && filter.q.trim() !== '') {
      and.push({ OR: employeeTextMatch(action.principal, filter.q.trim()) });
    }
    if (filter.departmentId !== undefined) {
      and.push({ departmentId: filter.departmentId });
    }
    if (filter.managerId !== undefined) {
      and.push({ managerProfileId: filter.managerId });
    }
    if (filter.teamId !== undefined) {
      and.push({ teamMemberships: { some: { organizationId, teamId: filter.teamId } } });
    }
    if (filter.employmentStatus !== undefined) {
      and.push({ employmentStatus: filter.employmentStatus });
    }
    if (filter.memberStatus !== undefined) {
      and.push({ member: { status: filter.memberStatus } });
    }
    if (filter.cursor !== undefined) {
      const [fullName = '', id = ''] = decodeCursor(filter.cursor, 2);
      and.push({ OR: [{ fullName: { gt: fullName } }, { fullName, id: { gt: id } }] });
    }
    const rows = await this.db.employeeProfile.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: size + 1,
      select: employeeSelect,
    });
    const page = toPage(rows, size, (row) => [row.fullName, row.id]);
    return { items: page.items.map((row) => this.toView(action, organizationId, row)), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, employeeId: string): Promise<EmployeeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.loadVisible(this.db, action, organizationId, employeeId);
    return this.toView(action, organizationId, row);
  }

  /** The caller's own profile (every member may read it). */
  async getOwn(action: ActionContext): Promise<EmployeeView | null> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.employeeProfile.findFirst({
      where: { organizationId, memberId: action.principal.memberId },
      select: employeeSelect,
    });
    return row === null ? null : this.toView(action, organizationId, row);
  }

  async updateOwn(action: ActionContext, changes: OwnProfileChanges): Promise<EmployeeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const own = await tx.employeeProfile.findFirst({
        where: { organizationId, memberId: action.principal.memberId },
        select: { id: true },
      });
      if (own === null) {
        throw new NotFoundError('Profile');
      }
      const data: Prisma.EmployeeProfileUncheckedUpdateInput = {};
      if (changes.phone !== undefined) data.phone = changes.phone;
      if (changes.timeZone !== undefined) data.timeZone = changes.timeZone;
      if (changes.locale !== undefined) data.locale = changes.locale;
      const row = await tx.employeeProfile.update({
        where: { organizationId_id: { organizationId, id: own.id } },
        data,
        select: employeeSelect,
      });
      await recordAudit(tx, organizationId, {
        action: 'employee.profile.self_updated',
        entityType: 'employee',
        entityId: own.id,
        actor: userActor(action),
        metadata: { fields: Object.keys(data).sort() },
        context: action.request,
      });
      return this.toView(action, organizationId, row);
    });
  }

  async create(
    action: ActionContext,
    input: NewEmployee,
  ): Promise<{ employee: EmployeeView; invitation: IssuedInvitation }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const departmentId = input.departmentId ?? null;
    if (
      !canAccessResource(action.principal, 'employee.manage', {
        organizationId,
        departmentIds: departmentId === null ? [] : [departmentId],
      })
    ) {
      throw new ForbiddenError();
    }
    try {
      return await this.db.$transaction(async (tx) => {
        await this.assertReferences(tx, action, organizationId, {
          departmentId,
          jobTitleId: input.jobTitleId ?? null,
          managerId: input.managerId ?? null,
        });
        const employeeNumber = input.employeeNumber ?? (await this.nextEmployeeNumber(tx, organizationId));
        const member = await tx.organizationMember.create({
          data: { organizationId, status: MemberStatus.INVITED, invitedByMemberId: action.principal.memberId },
          select: { id: true },
        });
        const profile = await tx.employeeProfile.create({
          data: {
            organizationId,
            memberId: member.id,
            employeeNumber,
            fullName: input.fullName,
            workEmail: input.workEmail ?? null,
            phone: input.phone ?? null,
            departmentId,
            jobTitleId: input.jobTitleId ?? null,
            managerProfileId: input.managerId ?? null,
            employmentType: input.employmentType ?? EmploymentType.FULL_TIME,
            joinDate: fromDateOnly(input.joinDate ?? null),
            timeZone: input.timeZone ?? null,
            locale: input.locale ?? null,
          },
          select: employeeSelect,
        });
        const baseline = await tx.role.findFirst({
          where: { organizationId, key: 'EMPLOYEE' },
          select: { id: true },
        });
        if (baseline !== null) {
          await tx.memberRole.create({
            data: {
              organizationId,
              memberId: member.id,
              roleId: baseline.id,
              grantedByMemberId: action.principal.memberId,
            },
          });
        }
        const invitation = await this.issueInvitation(tx, action, organizationId, member.id);
        await recordAudit(tx, organizationId, {
          action: 'employee.created',
          entityType: 'employee',
          entityId: profile.id,
          actor: userActor(action),
          metadata: {
            memberId: member.id,
            employeeNumber,
            departmentId,
            baselineRoleGranted: baseline !== null,
          },
          context: action.request,
        });
        return { employee: this.toView(action, organizationId, profile), invitation };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('An employee with this employee number already exists.');
      }
      throw error;
    }
  }

  async update(action: ActionContext, employeeId: string, changes: EmployeeChanges): Promise<EmployeeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    try {
      return await this.db.$transaction(async (tx) => {
        if (changes.managerId !== undefined) {
          await lockOrganizationHierarchy(tx, organizationId);
        }
        const current = await this.loadManageable(tx, action, organizationId, employeeId);
        if (changes.departmentId !== undefined && changes.departmentId !== current.departmentId) {
          const target = employeeFacts(organizationId, {
            memberId: current.memberId,
            departmentId: changes.departmentId,
          });
          if (!canAccessResource(action.principal, 'employee.manage', target)) {
            throw new ForbiddenError();
          }
        }
        const changed = <T>(next: T | null | undefined, previous: T | null): T | null =>
          next === undefined || next === null || next === previous ? null : next;
        await this.assertReferences(tx, action, organizationId, {
          departmentId: changed(changes.departmentId, current.departmentId),
          jobTitleId: changed(changes.jobTitleId, current.jobTitle?.id ?? null),
          managerId: changed(changes.managerId, current.manager?.id ?? null),
        });
        if (changes.managerId !== undefined && changes.managerId !== null) {
          if (await isInReportingSubtree(tx, organizationId, current.id, changes.managerId)) {
            throw new InvalidInputError('managerId', 'The manager cannot be this employee or one of their reports.');
          }
        }
        const data: Prisma.EmployeeProfileUncheckedUpdateInput = {};
        if (changes.fullName !== undefined) data.fullName = changes.fullName;
        if (changes.employeeNumber !== undefined) data.employeeNumber = changes.employeeNumber;
        if (changes.workEmail !== undefined) data.workEmail = changes.workEmail;
        if (changes.phone !== undefined) data.phone = changes.phone;
        if (changes.departmentId !== undefined) data.departmentId = changes.departmentId;
        if (changes.jobTitleId !== undefined) data.jobTitleId = changes.jobTitleId;
        if (changes.managerId !== undefined) data.managerProfileId = changes.managerId;
        if (changes.employmentStatus !== undefined) data.employmentStatus = changes.employmentStatus;
        if (changes.employmentType !== undefined) data.employmentType = changes.employmentType;
        if (changes.joinDate !== undefined) data.joinDate = fromDateOnly(changes.joinDate);
        if (changes.timeZone !== undefined) data.timeZone = changes.timeZone;
        if (changes.locale !== undefined) data.locale = changes.locale;
        const row = await tx.employeeProfile.update({
          where: { organizationId_id: { organizationId, id: current.id } },
          data,
          select: employeeSelect,
        });
        await recordAudit(tx, organizationId, {
          action: 'employee.updated',
          entityType: 'employee',
          entityId: current.id,
          actor: userActor(action),
          metadata: {
            fields: Object.keys(data).sort(),
            ...(changes.departmentId === undefined ? {} : { departmentId: changes.departmentId }),
            ...(changes.managerId === undefined ? {} : { managerId: changes.managerId }),
            ...(changes.employmentStatus === undefined ? {} : { employmentStatus: changes.employmentStatus }),
          },
          context: action.request,
        });
        return this.toView(action, organizationId, row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('An employee with this employee number already exists.');
      }
      throw error;
    }
  }

  /**
   * Disables or re-enables the employee's membership. Disabling ends the member's sessions on their
   * next request (`authz_version` bump + status check). Members cannot change their own status, and
   * the last active administrator cannot be disabled.
   */
  async setMemberStatus(
    action: ActionContext,
    employeeId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<EmployeeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      await lockOrganizationForAdminChange(tx, organizationId);
      const current = await this.loadManageable(tx, action, organizationId, employeeId);
      if (current.memberId === action.principal.memberId) {
        throw new ForbiddenError('You cannot change the status of your own membership.');
      }
      if (current.member.status === MemberStatus.INVITED) {
        throw new InvalidTransitionError('The invitation has not been accepted yet; revoke it instead.');
      }
      if (current.member.status === status) {
        return this.toView(action, organizationId, current);
      }
      if (status === MemberStatus.DISABLED) {
        await assertNotLastAdministrator(tx, organizationId, current.memberId);
      }
      await tx.organizationMember.update({
        where: { organizationId_id: { organizationId, id: current.memberId } },
        data: { status, authzVersion: { increment: 1 } },
        select: { id: true },
      });
      await recordAudit(tx, organizationId, {
        action: status === MemberStatus.DISABLED ? 'member.disabled' : 'member.enabled',
        entityType: 'member',
        entityId: current.memberId,
        actor: userActor(action),
        metadata: { employeeId: current.id },
        context: action.request,
      });
      const row = await tx.employeeProfile.findFirstOrThrow({
        where: { organizationId, id: current.id },
        select: employeeSelect,
      });
      return this.toView(action, organizationId, row);
    });
  }

  /** Revokes any open invitation of an INVITED employee and issues a new one. */
  async reissueInvitation(action: ActionContext, employeeId: string): Promise<IssuedInvitation> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const current = await this.loadManageable(tx, action, organizationId, employeeId);
      if (current.member.status !== MemberStatus.INVITED) {
        throw new InvalidTransitionError('Only invited employees can receive a new invitation.');
      }
      await this.revokeOpenInvitations(tx, organizationId, current.memberId);
      const invitation = await this.issueInvitation(tx, action, organizationId, current.memberId);
      await recordAudit(tx, organizationId, {
        action: 'member.invitation.reissued',
        entityType: 'member',
        entityId: current.memberId,
        actor: userActor(action),
        metadata: { employeeId: current.id, expiresAt: invitation.expiresAt },
        context: action.request,
      });
      return invitation;
    });
  }

  async revokeInvitation(action: ActionContext, employeeId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const current = await this.loadManageable(tx, action, organizationId, employeeId);
      const revoked = await this.revokeOpenInvitations(tx, organizationId, current.memberId);
      if (revoked === 0) {
        throw new InvalidTransitionError('There is no open invitation to revoke.');
      }
      await recordAudit(tx, organizationId, {
        action: 'member.invitation.revoked',
        entityType: 'member',
        entityId: current.memberId,
        actor: userActor(action),
        metadata: { employeeId: current.id },
        context: action.request,
      });
    });
  }

  /**
   * Avatar access for the attachment owner resolver: anyone who can view the employee can view the
   * avatar; the employee themself or `employee.manage` in scope can change it.
   */
  async avatarAccess(
    action: ActionContext,
    employeeId: string,
  ): Promise<{ canView: boolean; canChange: boolean; avatarAttachmentId: string | null }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const row = await this.db.employeeProfile.findFirst({
      where: { organizationId, id: employeeId },
      select: { memberId: true, departmentId: true, avatarAttachmentId: true },
    });
    if (row === null) {
      return { canView: false, canChange: false, avatarAttachmentId: null };
    }
    const facts = employeeFacts(organizationId, row);
    const canView = canAccessResource(action.principal, 'employee.view', facts);
    const canChange =
      canView &&
      (row.memberId === action.principal.memberId || canAccessResource(action.principal, 'employee.manage', facts));
    return { canView, canChange, avatarAttachmentId: row.avatarAttachmentId };
  }

  /** Sets (or clears) the avatar to an AVAILABLE attachment uploaded for this employee. */
  async setAvatar(action: ActionContext, employeeId: string, attachmentId: string | null): Promise<EmployeeView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const access = await this.avatarAccess(action, employeeId);
    if (!access.canView) {
      throw new NotFoundError('Employee');
    }
    if (!access.canChange) {
      throw new ForbiddenError();
    }
    return this.db.$transaction(async (tx) => {
      if (attachmentId !== null) {
        const attachment = await tx.attachment.findFirst({
          where: {
            organizationId,
            id: attachmentId,
            ownerType: 'EMPLOYEE_AVATAR',
            ownerId: employeeId,
            status: 'AVAILABLE',
          },
          select: { id: true },
        });
        if (attachment === null) {
          throw new NotFoundError('Attachment');
        }
      }
      const { avatarAttachmentId: previous } = await tx.employeeProfile.findFirstOrThrow({
        where: { organizationId, id: employeeId },
        select: { avatarAttachmentId: true },
      });
      const swapped = await tx.employeeProfile.updateMany({
        where: { organizationId, id: employeeId, avatarAttachmentId: previous },
        data: { avatarAttachmentId: attachmentId },
      });
      if (swapped.count === 0) {
        throw new ConflictError('The photo was changed at the same time. Try again.');
      }
      if (previous !== null && previous !== attachmentId) {
        await this.retireAvatar(tx, action, organizationId, employeeId, previous);
      }
      const row = await tx.employeeProfile.findFirstOrThrow({
        where: { organizationId, id: employeeId },
        select: employeeSelect,
      });
      await recordAudit(tx, organizationId, {
        action: attachmentId === null ? 'employee.avatar.cleared' : 'employee.avatar.set',
        entityType: 'employee',
        entityId: employeeId,
        actor: userActor(action),
        metadata: { attachmentId },
        context: action.request,
      });
      return this.toView(action, organizationId, row);
    });
  }

  /**
   * A replaced or cleared photo must stop being viewable: the attachment becomes DELETED (kept for
   * audit) and its stored object is removed by the outbox consumer.
   */
  private async retireAvatar(
    tx: TenantDb,
    action: ActionContext,
    organizationId: string,
    employeeId: string,
    attachmentId: string,
  ): Promise<void> {
    const retired = await tx.attachment.updateMany({
      where: { organizationId, id: attachmentId, ownerType: 'EMPLOYEE_AVATAR', status: { not: 'DELETED' } },
      data: { status: 'DELETED' },
    });
    if (retired.count === 0) {
      return;
    }
    await recordAudit(tx, organizationId, {
      action: 'attachment.deleted',
      entityType: 'attachment',
      entityId: attachmentId,
      actor: userActor(action),
      metadata: { ownerType: 'EMPLOYEE_AVATAR', ownerId: employeeId, reason: 'avatar_replaced' },
      context: action.request,
    });
    await enqueueOutboxEvent(tx, organizationId, {
      eventType: 'attachment.object.delete',
      aggregateType: 'attachment',
      aggregateId: attachmentId,
      payload: { attachmentId },
    });
  }

  private async loadVisible(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    employeeId: string,
  ): Promise<EmployeeRow> {
    const row = await db.employeeProfile.findFirst({
      where: { organizationId, id: employeeId },
      select: employeeSelect,
    });
    if (row === null || !canAccessResource(action.principal, 'employee.view', employeeFacts(organizationId, row))) {
      throw new NotFoundError('Employee');
    }
    return row;
  }

  private async loadManageable(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    employeeId: string,
  ): Promise<EmployeeRow> {
    const row = await this.loadVisible(db, action, organizationId, employeeId);
    if (!canAccessResource(action.principal, 'employee.manage', employeeFacts(organizationId, row))) {
      throw new ForbiddenError();
    }
    return row;
  }

  /**
   * Every referenced id must exist in the active organization (foreign ids are 404, never linked):
   * active department and job title, and a manager the caller can see.
   */
  private async assertReferences(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    refs: { departmentId: string | null; jobTitleId: string | null; managerId: string | null },
  ): Promise<void> {
    if (refs.departmentId !== null) {
      const department = await db.department.findFirst({
        where: { organizationId, id: refs.departmentId, archivedAt: null },
        select: { id: true },
      });
      if (department === null) {
        throw new NotFoundError('Department');
      }
    }
    if (refs.jobTitleId !== null) {
      const jobTitle = await db.jobTitle.findFirst({
        where: { organizationId, id: refs.jobTitleId, archivedAt: null },
        select: { id: true },
      });
      if (jobTitle === null) {
        throw new NotFoundError('Job title');
      }
    }
    if (refs.managerId !== null) {
      await this.loadVisible(db, action, organizationId, refs.managerId).catch((error: unknown) => {
        throw error instanceof NotFoundError ? new NotFoundError('Manager') : error;
      });
    }
  }

  /**
   * Next free `EMP-nnnnn` number. Numbers entered manually may be ahead of the counter, so taken
   * numbers are skipped (bounded) instead of failing the creation on the unique constraint.
   */
  private async nextEmployeeNumber(db: TenantDb, organizationId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_EMPLOYEE_NUMBER_ATTEMPTS; attempt += 1) {
      const candidate = `EMP-${String(await nextCounterValue(db, organizationId, 'EMP')).padStart(5, '0')}`;
      const taken = await db.employeeProfile.findFirst({
        where: { organizationId, employeeNumber: candidate },
        select: { id: true },
      });
      if (taken === null) {
        return candidate;
      }
    }
    throw new ConflictError('Could not allocate an employee number; enter one manually.');
  }

  private async issueInvitation(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    memberId: string,
  ): Promise<IssuedInvitation> {
    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    await db.memberInvitation.create({
      data: {
        organizationId,
        memberId,
        tokenHash: hashInvitationToken(token),
        expiresAt,
        createdByMemberId: action.principal.memberId,
      },
      select: { id: true },
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  private async revokeOpenInvitations(db: TenantDb, organizationId: string, memberId: string): Promise<number> {
    const result = await db.memberInvitation.updateMany({
      where: { organizationId, memberId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return result.count;
  }

  private toView(action: ActionContext, organizationId: string, row: EmployeeRow): EmployeeView {
    const contactVisible =
      row.memberId === action.principal.memberId ||
      canAccessResource(action.principal, 'employee.view_contact', employeeFacts(organizationId, row));
    return {
      id: row.id,
      memberId: row.memberId,
      employeeNumber: row.employeeNumber,
      fullName: row.fullName,
      workEmail: row.workEmail,
      phone: contactVisible ? row.phone : null,
      contactVisible,
      department: row.department,
      jobTitle: row.jobTitle,
      manager: row.manager,
      employmentStatus: row.employmentStatus,
      employmentType: row.employmentType,
      joinDate: toDateOnly(row.joinDate),
      memberStatus: row.member.status,
      hasAvatar: row.avatarAttachmentId !== null,
      timeZone: row.timeZone,
      locale: row.locale,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
