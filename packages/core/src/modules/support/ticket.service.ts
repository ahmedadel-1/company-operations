import type {
  Prisma,
  SlaState,
  TicketImpact,
  TicketPriority,
  TicketSeverity,
  TicketSource,
  TicketStatus,
} from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { escapeLike } from '../../platform/db/like.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { nextCounterValue } from '../../platform/db/sql/counters.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
} from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { loadMemberAccess } from '../authorization/member-access.js';
import { assertPermission, canAccessResource, listScope } from '../authorization/policy.js';
import type { Principal, ResourceFacts } from '../authorization/policy.js';
import { assertNotArchived, loadVisibleProject } from '../projects/project-access.js';
import { recordProjectActivity } from '../projects/project-activity.js';
import {
  assertTicketPermission,
  assertTicketUnlocked,
  holdsOnTicket,
  loadTicketForAccess,
  loadVisibleTicket,
  reporterScopeOf,
  ticketFacts,
  ticketKey,
  ticketScopeWhere,
} from './ticket-access.js';
import type { LoadedTicket } from './ticket-access.js';
import { INTERNAL_EVENT_TYPES, JIRA_EVENT_TYPES, recordTicketEvent } from './ticket-history.js';
import type { TicketEventType } from './ticket-history.js';
import { announceTicketChange, notifyTicketAudience, projectManagerIds, teamMemberIds } from './ticket-notify.js';
import { recordSlaConditions, SlaContext, slaColumns, snapshotOf } from './ticket-sla.js';
import {
  LOCKED_TICKET_STATUSES,
  mayTransition,
  nextStatuses,
  OPEN_TICKET_STATUSES,
  transitionRule,
} from './ticket-state-machine.js';
import { applyTransition, bumpTicket } from './ticket-workflow.js';
import {
  memberRefSelect,
  ticketDetailSelect,
  ticketSummarySelect,
  toPersonRef,
  toTicketSummary,
  toTicketView,
} from './ticket-views.js';
import type { TicketAccess, TicketPersonRef, TicketSummaryView, TicketView } from './ticket-views.js';

/** Priority derived from severity when a ticket is reported (ADR-0018); triagers may override it. */
export const DEFAULT_PRIORITY: Readonly<Record<TicketSeverity, TicketPriority>> = {
  CRITICAL: 'P1',
  HIGH: 'P2',
  MEDIUM: 'P3',
  LOW: 'P4',
};

const PRIORITY_ORDER: readonly TicketPriority[] = ['P1', 'P2', 'P3', 'P4'];
const RISK_STATES: SlaState[] = ['AT_RISK', 'BREACHED'];
const MAX_ASSIGNEE_CANDIDATES = 50;

export const TICKET_VIEWS = [
  'all',
  'open',
  'assigned_to_me',
  'reported_by_me',
  'watching',
  'unassigned',
  'untriaged',
  'critical',
  'sla_risk',
] as const;
export type TicketQueueView = (typeof TICKET_VIEWS)[number];

export type TicketSort = 'createdAt:desc' | 'createdAt:asc' | 'updatedAt:desc' | 'priority:asc';

export interface TicketListFilter {
  readonly view?: TicketQueueView | undefined;
  readonly q?: string | undefined;
  readonly status?: readonly TicketStatus[] | undefined;
  readonly severity?: readonly TicketSeverity[] | undefined;
  readonly priority?: readonly TicketPriority[] | undefined;
  readonly projectId?: string | undefined;
  readonly teamId?: string | undefined;
  readonly assigneeMemberId?: string | undefined;
  readonly reporterMemberId?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly componentId?: string | undefined;
  readonly slaState?: readonly SlaState[] | undefined;
  readonly createdFrom?: string | undefined;
  readonly createdTo?: string | undefined;
  readonly resolvedFrom?: string | undefined;
  readonly resolvedTo?: string | undefined;
  readonly sort?: TicketSort | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface CreateTicketInput {
  readonly title: string;
  readonly description: string;
  readonly severity: TicketSeverity;
  readonly impact: TicketImpact;
  readonly source?: TicketSource | undefined;
  readonly priority?: TicketPriority | undefined;
  readonly projectId?: string | null | undefined;
  readonly categoryId?: string | null | undefined;
  readonly componentId?: string | null | undefined;
}

export interface UpdateTicketInput {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly severity?: TicketSeverity | undefined;
  readonly priority?: TicketPriority | undefined;
  readonly impact?: TicketImpact | undefined;
  readonly source?: TicketSource | undefined;
  readonly projectId?: string | null | undefined;
  readonly categoryId?: string | null | undefined;
  readonly componentId?: string | null | undefined;
}

export interface AssignTicketInput {
  readonly teamId?: string | null | undefined;
  readonly assigneeMemberId?: string | null | undefined;
}

export interface TransitionTicketInput {
  readonly to: TicketStatus;
  readonly note?: string | null | undefined;
}

export interface TicketEventView {
  readonly id: string;
  readonly type: string;
  readonly actor: TicketPersonRef | null;
  readonly from: Prisma.JsonValue | null;
  readonly to: Prisma.JsonValue | null;
  readonly metadata: Prisma.JsonValue;
  readonly createdAt: string;
}

export interface ProjectSupportSummary {
  readonly projectId: string;
  readonly supportTeam: { readonly id: string; readonly name: string } | null;
  readonly openCount: number;
  readonly criticalOpenCount: number;
  readonly slaRiskCount: number;
  readonly byStatus: Readonly<Partial<Record<TicketStatus, number>>>;
  readonly canManageSupportTeam: boolean;
}

const SORTS: Readonly<
  Record<Exclude<TicketSort, 'priority:asc'>, { field: 'createdAt' | 'updatedAt'; dir: 'asc' | 'desc' }>
> = {
  'createdAt:desc': { field: 'createdAt', dir: 'desc' },
  'createdAt:asc': { field: 'createdAt', dir: 'asc' },
  'updatedAt:desc': { field: 'updatedAt', dir: 'desc' },
};

const KEY_PATTERN = /^(?:SUP-)?(\d{1,9})$/i;

/**
 * Support tickets (Phase 3). Visibility follows the `support.view` scope evaluated against the
 * ticket's reporter, assignee, their departments and the ticket's project; anything out of scope is
 * 404, visible-but-not-permitted is 403. Lifecycle changes go to the append-only ticket history;
 * assignment and configuration changes are also audited. Every write is version-checked.
 */
export class TicketService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---- Reads ----

  async list(action: ActionContext, filter: TicketListFilter): Promise<Page<TicketSummaryView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const size = pageSize(filter.limit);
    const and = ticketListWhere(action.principal, organizationId, filter);
    if (and === 'none') {
      return { items: [], nextCursor: null };
    }

    const sortKey = filter.sort ?? 'createdAt:desc';
    if (sortKey === 'priority:asc') {
      if (filter.cursor !== undefined) {
        const [priority = '', id = ''] = decodeCursor(filter.cursor, 2);
        const key = PRIORITY_ORDER.find((value) => value === priority);
        if (key === undefined) {
          throw new InvalidInputError('cursor', 'The cursor is invalid.');
        }
        and.push({
          OR: [
            { priority: { in: PRIORITY_ORDER.slice(PRIORITY_ORDER.indexOf(key) + 1) } },
            { priority: key, id: { lt: id } },
          ],
        });
      }
      const rows = await this.db.supportTicket.findMany({
        where: { organizationId, AND: and },
        orderBy: [{ priority: 'asc' }, { id: 'desc' }],
        take: size + 1,
        select: ticketSummarySelect,
      });
      const page = toPage(rows, size, (row) => [row.priority, row.id]);
      return { items: page.items.map(toTicketSummary), nextCursor: page.nextCursor };
    }
    const sort = SORTS[sortKey];
    if (filter.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(filter.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      const beyond = sort.dir === 'desc' ? { lt: key } : { gt: key };
      const idBeyond = sort.dir === 'desc' ? { lt: id } : { gt: id };
      and.push({ OR: [{ [sort.field]: beyond }, { [sort.field]: key, id: idBeyond }] });
    }
    const rows = await this.db.supportTicket.findMany({
      where: { organizationId, AND: and },
      orderBy: [{ [sort.field]: sort.dir }, { id: sort.dir }],
      take: size + 1,
      select: ticketSummarySelect,
    });
    const page = toPage(rows, size, (row) => [row[sort.field].toISOString(), row.id]);
    return { items: page.items.map(toTicketSummary), nextCursor: page.nextCursor };
  }

  async get(action: ActionContext, ticketId: string): Promise<TicketView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    return this.view(this.db, action, organizationId, ticket);
  }

  /**
   * History, oldest first. Internal-note events are omitted unless the caller may read internal notes;
   * Jira events unless the caller holds `jira.view` on the ticket.
   */
  async history(
    action: ActionContext,
    ticketId: string,
    paging: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<Page<TicketEventView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    const size = pageSize(paging.limit);
    const and: Prisma.SupportTicketEventWhereInput[] = [];
    if (!holdsOnTicket(action.principal, 'support.internal_note', ticket)) {
      and.push({ type: { notIn: [...INTERNAL_EVENT_TYPES] } });
    }
    if (!holdsOnTicket(action.principal, 'jira.view', ticket)) {
      and.push({ type: { notIn: [...JIRA_EVENT_TYPES] } });
    }
    if (paging.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(paging.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { gt: key } }, { createdAt: key, id: { gt: id } }] });
    }
    const rows = await this.db.supportTicketEvent.findMany({
      where: { organizationId, ticketId: ticket.row.id, AND: and },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: size + 1,
      select: {
        id: true,
        type: true,
        fromValue: true,
        toValue: true,
        metadata: true,
        createdAt: true,
        actorMember: { select: memberRefSelect },
      },
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return {
      items: page.items.map((row) => ({
        id: row.id,
        type: row.type,
        actor: row.actorMember === null ? null : toPersonRef(row.actorMember),
        from: row.fromValue,
        to: row.toValue,
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** Members the caller may assign the ticket to (eligibility is re-checked on assignment). */
  async assignableMembers(
    action: ActionContext,
    ticketId: string,
    filter: { readonly teamId?: string | undefined; readonly q?: string | undefined },
  ): Promise<TicketPersonRef[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    assertTicketPermission(action, 'support.assign', ticket);
    const teamId = filter.teamId ?? ticket.row.assignedTeamId;
    const q = filter.q?.trim();
    const candidates = await this.db.organizationMember.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        userId: { not: null },
        roles: { some: { role: { permissions: { some: { permissionKey: 'support.comment' } } } } },
        AND: [
          ...(teamId === null ? [] : [{ profile: { is: { teamMemberships: { some: { teamId } } } } }]),
          ...(q === undefined || q === ''
            ? []
            : [
                {
                  OR: [
                    { profile: { is: { fullName: { contains: q, mode: 'insensitive' as const } } } },
                    { user: { is: { displayName: { contains: q, mode: 'insensitive' as const } } } },
                  ],
                },
              ]),
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_ASSIGNEE_CANDIDATES,
      select: memberRefSelect,
    });
    const access = await loadMemberAccess(
      this.db,
      organizationId,
      candidates.map((candidate) => candidate.id),
    );
    const facts = ticketFacts(organizationId, ticket.row, true);
    return candidates
      .filter((candidate) => {
        const member = access.get(candidate.id);
        return member !== undefined && isWorkable(member.employmentStatus, member.principal, facts);
      })
      .map(toPersonRef)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async projectSummary(action: ActionContext, projectId: string): Promise<ProjectSupportSummary> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const project = await loadVisibleProject(this.db, action, organizationId, projectId);
    const scope = listScope(action.principal, 'support.view');
    const scopeWhere = ticketScopeWhere(scope, reporterScopeOf(action.principal));
    const supportTeam = await this.db.project.findFirstOrThrow({
      where: { organizationId, id: project.id },
      select: { supportTeam: { select: { id: true, name: true } } },
    });
    const canManageSupportTeam =
      project.row.status !== 'ARCHIVED' && canAccessResource(action.principal, 'project.manage', project.facts);
    if (scopeWhere === 'none') {
      return {
        projectId: project.id,
        supportTeam: supportTeam.supportTeam,
        openCount: 0,
        criticalOpenCount: 0,
        slaRiskCount: 0,
        byStatus: {},
        canManageSupportTeam,
      };
    }
    const base: Prisma.SupportTicketWhereInput[] = [
      { projectId: project.id, status: { in: [...OPEN_TICKET_STATUSES] } },
      ...(scopeWhere === null ? [] : [scopeWhere]),
    ];
    const grouped = await this.db.supportTicket.groupBy({
      by: ['status'],
      where: { organizationId, AND: base },
      _count: { _all: true },
    });
    const criticalOpenCount = await this.db.supportTicket.count({
      where: { organizationId, AND: [...base, { severity: 'CRITICAL' }] },
    });
    const slaRiskCount = await this.db.supportTicket.count({
      where: {
        organizationId,
        AND: [
          ...base,
          { OR: [{ firstResponseSlaState: { in: RISK_STATES } }, { resolutionSlaState: { in: RISK_STATES } }] },
        ],
      },
    });
    const byStatus: Partial<Record<TicketStatus, number>> = {};
    let openCount = 0;
    for (const group of grouped) {
      byStatus[group.status] = group._count._all;
      openCount += group._count._all;
    }
    return {
      projectId: project.id,
      supportTeam: supportTeam.supportTeam,
      openCount,
      criticalOpenCount,
      slaRiskCount,
      byStatus,
      canManageSupportTeam,
    };
  }

  // ---- Writes ----

  async create(action: ActionContext, input: CreateTicketInput, idempotencyKey?: string): Promise<TicketView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'support.create');
    const reporterMemberId = action.principal.memberId;
    if (idempotencyKey !== undefined) {
      const replay = await this.replay(action, organizationId, idempotencyKey, input);
      if (replay !== null) {
        return replay;
      }
    }
    try {
      return await this.db.$transaction(async (tx) => {
        const now = this.clock();
        const projectId = input.projectId ?? null;
        let supportTeamId: string | null = null;
        let projectTimeZone: string | null = null;
        if (projectId !== null) {
          const project = await loadVisibleProject(tx, action, organizationId, projectId);
          assertNotArchived(project);
          const support = await tx.project.findFirstOrThrow({
            where: { organizationId, id: project.id },
            select: { supportTeamId: true, supportTeam: { select: { archivedAt: true } } },
          });
          supportTeamId = support.supportTeam?.archivedAt === null ? support.supportTeamId : null;
          projectTimeZone = project.row.timeZone;
        }
        const facts: ResourceFacts = {
          organizationId,
          ownerMemberIds: [reporterMemberId],
          subjectMemberIds: [reporterMemberId],
          projectIds: projectId === null ? [] : [projectId],
        };
        if (input.priority !== undefined && !canAccessResource(action.principal, 'support.triage', facts)) {
          throw new ForbiddenError('Only triagers can set the priority of a new ticket.');
        }
        await assertCategory(tx, organizationId, input.categoryId ?? null);
        await assertComponent(tx, organizationId, input.componentId ?? null, projectId);
        const priority = input.priority ?? DEFAULT_PRIORITY[input.severity];
        const categoryId = input.categoryId ?? null;
        const sla = new SlaContext(tx, organizationId);
        const policy = await sla.resolve(
          { severity: input.severity, priority, projectId, categoryId },
          projectTimeZone,
        );
        const { columns } = slaColumns(
          policy,
          {
            status: 'NEW',
            startedAt: now,
            firstRespondedAt: null,
            resolvedAt: null,
            pausedSince: null,
            pausedSeconds: 0,
            firstResponseState: null,
            resolutionState: null,
          },
          now,
        );
        const number = Number(await nextCounterValue(tx, organizationId, 'SUP'));
        const created = await tx.supportTicket.create({
          data: {
            organizationId,
            number,
            projectId,
            reporterMemberId,
            source: input.source ?? 'INTERNAL',
            categoryId,
            componentId: input.componentId ?? null,
            title: input.title,
            description: input.description,
            severity: input.severity,
            priority,
            impact: input.impact,
            assignedTeamId: supportTeamId,
            slaStartedAt: now,
            ...columns,
            idempotencyKey: idempotencyKey ?? null,
          },
          select: { id: true },
        });
        const eventId = await recordTicketEvent(tx, organizationId, created.id, {
          type: 'CREATED',
          actorMemberId: reporterMemberId,
          to: { status: 'NEW' },
          metadata: {
            severity: input.severity,
            priority,
            impact: input.impact,
            source: input.source ?? 'INTERNAL',
            ...(supportTeamId === null ? {} : { assignedTeamId: supportTeamId }),
            ...(policy === null ? {} : { slaPolicyId: policy.id }),
          },
        });
        const ticket = await this.mustLoad(tx, organizationId, created.id);
        const audience = await teamMemberIds(tx, organizationId, supportTeamId);
        if (input.severity === 'CRITICAL') {
          audience.push(...projectManagerIds(ticket));
        }
        await notifyTicketAudience(
          tx,
          organizationId,
          ticket,
          audience,
          {
            type: 'SUPPORT_TICKET_CREATED',
            severity: input.severity === 'CRITICAL' ? 'CRITICAL' : 'INFO',
            email: false,
            causeId: eventId,
          },
          reporterMemberId,
        );
        if (projectId !== null) {
          await recordProjectActivity(tx, organizationId, projectId, reporterMemberId, {
            source: 'SUPPORT',
            type: 'support.ticket_created',
            entityType: 'support_ticket',
            entityId: created.id,
            summaryParams: { ticketNumber: ticketKey(number), status: 'NEW' },
          });
        }
        await announceTicketChange(tx, organizationId, created.id, true);
        return this.view(tx, action, organizationId, ticket);
      });
    } catch (error) {
      if (idempotencyKey !== undefined && isUniqueViolation(error)) {
        const replay = await this.replay(action, organizationId, idempotencyKey, input);
        if (replay !== null) {
          return replay;
        }
      }
      throw error;
    }
  }

  /**
   * Edits details (title, description: the reporter while NEW, or a triager) and classification
   * (severity, priority, impact, source, project, category, component: triagers only). A change to
   * anything an SLA policy matches on re-resolves the policy and recomputes the due dates from the
   * original start; breaches already recorded stay breached.
   */
  async update(
    action: ActionContext,
    ticketId: string,
    expectedVersion: number,
    input: UpdateTicketInput,
  ): Promise<TicketView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const now = this.clock();
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      assertTicketUnlocked(ticket);
      const { row } = ticket;
      const triager = holdsOnTicket(action.principal, 'support.triage', ticket);
      const isReporter = row.reporterMemberId === action.principal.memberId;
      const editsDetails = input.title !== undefined || input.description !== undefined;
      const classifies =
        input.severity !== undefined ||
        input.priority !== undefined ||
        input.impact !== undefined ||
        input.source !== undefined ||
        input.projectId !== undefined ||
        input.categoryId !== undefined ||
        input.componentId !== undefined;
      if ((editsDetails && !triager && !(isReporter && row.status === 'NEW')) || (classifies && !triager)) {
        throw new ForbiddenError();
      }
      const current = await tx.supportTicket.findFirstOrThrow({
        where: { organizationId, id: row.id },
        select: { description: true },
      });
      const projectId = input.projectId === undefined ? row.projectId : input.projectId;
      let projectTimeZone = row.project?.timeZone ?? null;
      if (input.projectId !== undefined && input.projectId !== row.projectId && input.projectId !== null) {
        const project = await loadVisibleProject(tx, action, organizationId, input.projectId);
        assertNotArchived(project);
        projectTimeZone = project.row.timeZone;
      } else if (input.projectId === null) {
        projectTimeZone = null;
      }
      const categoryId = input.categoryId === undefined ? row.categoryId : input.categoryId;
      const componentId = input.componentId === undefined ? row.componentId : input.componentId;
      if (input.categoryId !== undefined && input.categoryId !== row.categoryId) {
        await assertCategory(tx, organizationId, input.categoryId);
      }
      if (
        (input.componentId !== undefined && input.componentId !== row.componentId) ||
        (input.projectId !== undefined && input.projectId !== row.projectId)
      ) {
        await assertComponent(tx, organizationId, componentId, projectId);
      }

      const data: Prisma.SupportTicketUncheckedUpdateManyInput = {};
      const changes: { type: TicketEventType; from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null }[] =
        [];
      const detailFields: string[] = [];
      if (input.title !== undefined && input.title !== row.title) {
        data.title = input.title;
        detailFields.push('title');
      }
      if (input.description !== undefined && input.description !== current.description) {
        data.description = input.description;
        detailFields.push('description');
      }
      const track = <
        K extends 'severity' | 'priority' | 'impact' | 'source' | 'projectId' | 'categoryId' | 'componentId',
      >(
        field: K,
        value: (typeof row)[K] | undefined,
        type: TicketEventType,
      ): void => {
        if (value !== undefined && value !== row[field]) {
          Object.assign(data, { [field]: value });
          changes.push({ type, from: { [field]: row[field] }, to: { [field]: value } });
        }
      };
      track('severity', input.severity, 'SEVERITY_CHANGED');
      track('priority', input.priority, 'PRIORITY_CHANGED');
      track('impact', input.impact, 'IMPACT_CHANGED');
      track('source', input.source, 'SOURCE_CHANGED');
      track('projectId', input.projectId, 'PROJECT_CHANGED');
      track('categoryId', input.categoryId, 'CATEGORY_CHANGED');
      track('componentId', input.componentId, 'COMPONENT_CHANGED');
      if (Object.keys(data).length === 0) {
        return this.view(tx, action, organizationId, ticket);
      }

      const severity = input.severity ?? row.severity;
      const priority = input.priority ?? row.priority;
      const slaRelevant =
        severity !== row.severity ||
        priority !== row.priority ||
        projectId !== row.projectId ||
        categoryId !== row.categoryId;
      let reached: Awaited<ReturnType<typeof slaColumns>>['reached'] = [];
      let policyChange: { from: string | null; to: string | null } | null = null;
      if (slaRelevant && row.status !== 'CLOSED' && row.status !== 'CANCELLED') {
        const sla = new SlaContext(tx, organizationId);
        const policy = await sla.resolve({ severity, priority, projectId, categoryId }, projectTimeZone);
        if ((policy?.id ?? null) !== row.slaPolicyId) {
          const evaluated = slaColumns(policy, snapshotOf(row), now);
          Object.assign(data, evaluated.columns);
          if (policy === null) {
            data.slaPausedSince = null;
            data.slaPausedTotalSeconds = 0;
          }
          reached = evaluated.reached;
          policyChange = { from: row.slaPolicyId, to: policy?.id ?? null };
        }
      }
      await bumpTicket(tx, organizationId, row.id, expectedVersion, data);
      const actorMemberId = action.principal.memberId;
      if (detailFields.length > 0) {
        await recordTicketEvent(tx, organizationId, row.id, {
          type: 'DETAILS_EDITED',
          actorMemberId,
          metadata: { fields: detailFields },
        });
      }
      for (const change of changes) {
        await recordTicketEvent(tx, organizationId, row.id, { ...change, actorMemberId });
      }
      if (policyChange !== null) {
        await recordTicketEvent(tx, organizationId, row.id, {
          type: 'SLA_POLICY_CHANGED',
          actorMemberId,
          from: { slaPolicyId: policyChange.from },
          to: { slaPolicyId: policyChange.to },
        });
      }
      const updated = await this.mustLoad(tx, organizationId, row.id);
      if (reached.length > 0) {
        await recordSlaConditions(tx, organizationId, updated, reached);
      }
      await announceTicketChange(tx, organizationId, row.id, severity === 'CRITICAL');
      return this.view(tx, action, organizationId, updated);
    });
  }

  /**
   * Sets the assigned team and/or assignee (`support.assign`). The assignee must be an active member
   * whose employment is active, who belongs to the assigned team (when one is set) and who could
   * view and comment on the ticket in their own right. Audited and recorded in the history.
   */
  async assign(
    action: ActionContext,
    ticketId: string,
    expectedVersion: number,
    input: AssignTicketInput,
  ): Promise<TicketView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      assertTicketPermission(action, 'support.assign', ticket);
      assertTicketUnlocked(ticket);
      const { row } = ticket;
      const teamId = input.teamId === undefined ? row.assignedTeamId : input.teamId;
      const assigneeMemberId = input.assigneeMemberId === undefined ? row.assigneeMemberId : input.assigneeMemberId;
      if (teamId === row.assignedTeamId && assigneeMemberId === row.assigneeMemberId) {
        return this.view(tx, action, organizationId, ticket);
      }
      if (teamId !== null && teamId !== row.assignedTeamId) {
        const team = await tx.team.findFirst({ where: { organizationId, id: teamId }, select: { archivedAt: true } });
        if (team === null) {
          throw new NotFoundError('Team');
        }
        if (team.archivedAt !== null) {
          throw new InvalidInputError('teamId', 'Archived teams cannot be assigned tickets.');
        }
      }
      if (assigneeMemberId !== null) {
        await assertAssignable(tx, organizationId, ticket, assigneeMemberId, teamId);
      }
      await bumpTicket(tx, organizationId, row.id, expectedVersion, { assignedTeamId: teamId, assigneeMemberId });
      const actorMemberId = action.principal.memberId;
      let teamEventId: string | null = null;
      let assigneeEventId: string | null = null;
      if (teamId !== row.assignedTeamId) {
        teamEventId = await recordTicketEvent(tx, organizationId, row.id, {
          type: 'TEAM_CHANGED',
          actorMemberId,
          from: { teamId: row.assignedTeamId },
          to: { teamId },
        });
      }
      if (assigneeMemberId !== row.assigneeMemberId) {
        assigneeEventId = await recordTicketEvent(tx, organizationId, row.id, {
          type: assigneeMemberId === null ? 'UNASSIGNED' : 'ASSIGNED',
          actorMemberId,
          from: { memberId: row.assigneeMemberId },
          to: { memberId: assigneeMemberId },
        });
      }
      await recordAudit(tx, organizationId, {
        action: 'support.ticket.assigned',
        entityType: 'support_ticket',
        entityId: row.id,
        actor: userActor(action),
        metadata: {
          ticketNumber: row.number,
          fromTeamId: row.assignedTeamId,
          toTeamId: teamId,
          fromAssigneeMemberId: row.assigneeMemberId,
          toAssigneeMemberId: assigneeMemberId,
        },
        context: action.request,
      });
      const updated = await this.mustLoad(tx, organizationId, row.id);
      if (assigneeEventId !== null && assigneeMemberId !== null) {
        await notifyTicketAudience(
          tx,
          organizationId,
          updated,
          [assigneeMemberId],
          { type: 'SUPPORT_TICKET_ASSIGNED', severity: 'INFO', email: true, causeId: assigneeEventId },
          actorMemberId,
        );
      }
      if (teamEventId !== null && teamId !== null && assigneeMemberId === null) {
        await notifyTicketAudience(
          tx,
          organizationId,
          updated,
          await teamMemberIds(tx, organizationId, teamId),
          { type: 'SUPPORT_TICKET_TEAM_ASSIGNED', severity: 'INFO', email: false, causeId: teamEventId },
          actorMemberId,
        );
      }
      await announceTicketChange(tx, organizationId, row.id, true);
      return this.view(tx, action, organizationId, updated);
    });
  }

  async transition(
    action: ActionContext,
    ticketId: string,
    expectedVersion: number,
    input: TransitionTicketInput,
  ): Promise<TicketView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      const rule = transitionRule(ticket.row.status, input.to);
      if (rule === null) {
        throw new InvalidTransitionError(`A ${ticket.row.status} ticket cannot move to ${input.to}.`);
      }
      const allowed = mayTransition(rule, {
        isReporter: ticket.row.reporterMemberId === action.principal.memberId,
        holds: (permission) => holdsOnTicket(action.principal, permission, ticket),
      });
      if (!allowed) {
        throw new ForbiddenError();
      }
      const note = input.note?.trim() ?? '';
      if (rule.noteRequired && note === '') {
        throw new InvalidInputError('note', 'A note is required for this change.');
      }
      await applyTransition(
        tx,
        organizationId,
        ticket,
        {
          to: input.to,
          rule,
          note: note === '' ? null : note,
          actorMemberId: action.principal.memberId,
          expectedVersion,
        },
        this.clock(),
      );
      return this.view(tx, action, organizationId, await this.mustLoad(tx, organizationId, ticket.row.id));
    });
  }

  // ---- Helpers ----

  private async replay(
    action: ActionContext,
    organizationId: string,
    idempotencyKey: string,
    input: CreateTicketInput,
  ): Promise<TicketView | null> {
    const existing = await this.db.supportTicket.findFirst({
      where: { organizationId, reporterMemberId: action.principal.memberId, idempotencyKey },
      select: { id: true, title: true, severity: true, description: true },
    });
    if (existing === null) {
      return null;
    }
    if (
      existing.title !== input.title ||
      existing.severity !== input.severity ||
      existing.description !== input.description
    ) {
      throw new ConflictError('This Idempotency-Key was already used for a different ticket.');
    }
    const ticket = await this.mustLoad(this.db, organizationId, existing.id);
    return this.view(this.db, action, organizationId, ticket);
  }

  private async mustLoad(db: TenantDb, organizationId: string, ticketId: string): Promise<LoadedTicket> {
    const ticket = await loadTicketForAccess(db, organizationId, ticketId);
    if (ticket === null) {
      throw new NotFoundError('Ticket');
    }
    return ticket;
  }

  private async view(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    ticket: LoadedTicket,
  ): Promise<TicketView> {
    const row = await db.supportTicket.findFirstOrThrow({
      where: { organizationId, id: ticket.row.id },
      select: ticketDetailSelect,
    });
    const watching = await db.supportTicketWatcher.findFirst({
      where: { organizationId, ticketId: row.id, memberId: action.principal.memberId },
      select: { id: true },
    });
    return toTicketView(row, watching !== null, ticketAccess(action, ticket));
  }
}

export function ticketAccess(action: ActionContext, ticket: LoadedTicket): TicketAccess {
  const can = (permission: Parameters<typeof holdsOnTicket>[1]): boolean =>
    holdsOnTicket(action.principal, permission, ticket);
  const { status, reporterMemberId } = ticket.row;
  const live = !LOCKED_TICKET_STATUSES.includes(status);
  const isReporter = reporterMemberId === action.principal.memberId;
  const transitions = nextStatuses(status).flatMap((to) => {
    const rule = transitionRule(status, to);
    return rule !== null && mayTransition(rule, { isReporter, holds: can })
      ? [{ to, noteRequired: rule.noteRequired }]
      : [];
  });
  return {
    canEdit: live && (can('support.triage') || (isReporter && status === 'NEW')),
    canClassify: live && can('support.triage'),
    canAssign: live && can('support.assign'),
    canComment: live && can('support.comment'),
    canAddInternalNote: live && can('support.internal_note'),
    canViewInternalNotes: can('support.internal_note'),
    canWatch: live,
    canManageWatchers: live && can('support.assign'),
    canAttach: live && can('support.comment'),
    transitions,
  };
}

/**
 * The ticket queue's filter (scope + view + filters, no cursor) as `where` fragments AND-ed with the
 * organization binding; `'none'` = nothing visible. Shared with the dashboard counts (ADR-0023) so a
 * count and the list it links to always apply the same rules.
 */
export function ticketListWhere(
  principal: Principal,
  organizationId: string,
  filter: Omit<TicketListFilter, 'cursor' | 'limit' | 'sort'>,
): Prisma.SupportTicketWhereInput[] | 'none' {
  const scopeWhere = ticketScopeWhere(listScope(principal, 'support.view'), reporterScopeOf(principal));
  if (scopeWhere === 'none') {
    return 'none';
  }
  const and: Prisma.SupportTicketWhereInput[] = scopeWhere === null ? [] : [scopeWhere];
  and.push(...viewWhere(filter.view ?? 'all', principal.memberId, organizationId));
  if (filter.status !== undefined && filter.status.length > 0) and.push({ status: { in: [...filter.status] } });
  if (filter.severity !== undefined && filter.severity.length > 0) and.push({ severity: { in: [...filter.severity] } });
  if (filter.priority !== undefined && filter.priority.length > 0) and.push({ priority: { in: [...filter.priority] } });
  if (filter.projectId !== undefined) and.push({ projectId: filter.projectId });
  if (filter.teamId !== undefined) and.push({ assignedTeamId: filter.teamId });
  if (filter.assigneeMemberId !== undefined) and.push({ assigneeMemberId: filter.assigneeMemberId });
  if (filter.reporterMemberId !== undefined) and.push({ reporterMemberId: filter.reporterMemberId });
  if (filter.categoryId !== undefined) and.push({ categoryId: filter.categoryId });
  if (filter.componentId !== undefined) and.push({ componentId: filter.componentId });
  if (filter.slaState !== undefined && filter.slaState.length > 0) {
    const states = [...filter.slaState];
    and.push({ OR: [{ firstResponseSlaState: { in: states } }, { resolutionSlaState: { in: states } }] });
  }
  if (filter.createdFrom !== undefined) and.push({ createdAt: { gte: new Date(filter.createdFrom) } });
  if (filter.createdTo !== undefined) and.push({ createdAt: { lt: new Date(filter.createdTo) } });
  if (filter.resolvedFrom !== undefined) and.push({ resolvedAt: { gte: new Date(filter.resolvedFrom) } });
  if (filter.resolvedTo !== undefined) and.push({ resolvedAt: { lt: new Date(filter.resolvedTo) } });
  const q = filter.q?.trim();
  if (q !== undefined && q !== '') {
    const keyMatch = KEY_PATTERN.exec(q);
    and.push({
      OR: [
        { title: { contains: escapeLike(q), mode: 'insensitive' } },
        ...(keyMatch?.[1] === undefined ? [] : [{ number: Number(keyMatch[1]) }]),
      ],
    });
  }
  return and;
}

function viewWhere(view: TicketQueueView, memberId: string, organizationId: string): Prisma.SupportTicketWhereInput[] {
  const open: Prisma.SupportTicketWhereInput = { status: { in: [...OPEN_TICKET_STATUSES] } };
  switch (view) {
    case 'all':
      return [];
    case 'open':
      return [open];
    case 'assigned_to_me':
      return [{ assigneeMemberId: memberId }];
    case 'reported_by_me':
      return [{ reporterMemberId: memberId }];
    case 'watching':
      return [{ watchers: { some: { organizationId, memberId } } }];
    case 'unassigned':
      return [open, { assigneeMemberId: null }];
    case 'untriaged':
      return [{ status: 'NEW' }];
    case 'critical':
      return [open, { severity: 'CRITICAL' }];
    case 'sla_risk':
      return [
        open,
        { OR: [{ firstResponseSlaState: { in: RISK_STATES } }, { resolutionSlaState: { in: RISK_STATES } }] },
      ];
  }
}

function isWorkable(
  employmentStatus: string | null,
  principal: Parameters<typeof canAccessResource>[0],
  facts: ResourceFacts,
): boolean {
  return (
    (employmentStatus === null || employmentStatus === 'ACTIVE') &&
    canAccessResource(principal, 'support.view', facts) &&
    canAccessResource(principal, 'support.comment', facts)
  );
}

async function assertAssignable(
  db: TenantDb,
  organizationId: string,
  ticket: LoadedTicket,
  memberId: string,
  teamId: string | null,
): Promise<void> {
  const member = (await loadMemberAccess(db, organizationId, [memberId])).get(memberId);
  if (member === undefined) {
    throw new InvalidInputError('assigneeMemberId', 'Only active members can be assigned.');
  }
  if (member.employmentStatus !== null && member.employmentStatus !== 'ACTIVE') {
    throw new InvalidInputError('assigneeMemberId', 'Members on leave, suspended or terminated cannot be assigned.');
  }
  if (teamId !== null) {
    const inTeam = await db.teamMember.findFirst({
      where: { organizationId, teamId, profile: { memberId } },
      select: { id: true },
    });
    if (inTeam === null) {
      throw new InvalidInputError('assigneeMemberId', 'The assignee must be a member of the assigned team.');
    }
  }
  if (!isWorkable(member.employmentStatus, member.principal, ticketFacts(organizationId, ticket.row, true))) {
    throw new InvalidInputError('assigneeMemberId', 'This member cannot work on this ticket.');
  }
}

async function assertCategory(db: TenantDb, organizationId: string, categoryId: string | null): Promise<void> {
  if (categoryId === null) {
    return;
  }
  const category = await db.supportCategory.findFirst({
    where: { organizationId, id: categoryId },
    select: { active: true },
  });
  if (category === null) {
    throw new NotFoundError('Category');
  }
  if (!category.active) {
    throw new InvalidInputError('categoryId', 'This category is no longer in use.');
  }
}

async function assertComponent(
  db: TenantDb,
  organizationId: string,
  componentId: string | null,
  projectId: string | null,
): Promise<void> {
  if (componentId === null) {
    return;
  }
  const component = await db.supportComponent.findFirst({
    where: { organizationId, id: componentId },
    select: { active: true, projectId: true },
  });
  if (component === null) {
    throw new NotFoundError('Component');
  }
  if (!component.active) {
    throw new InvalidInputError('componentId', 'This component is no longer in use.');
  }
  if (component.projectId !== null && component.projectId !== projectId) {
    throw new InvalidInputError('componentId', 'This component belongs to a different project.');
  }
}
