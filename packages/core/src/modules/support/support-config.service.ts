import type {
  EscalationTrigger,
  Prisma,
  ProjectRole,
  TicketPriority,
  TicketSeverity,
  TicketStatus,
} from '@company-ops/db';
import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { assertPermission } from '../authorization/policy.js';
import { isValidTimeZone } from '../organizations/provision-organization.js';
import {
  assertNotArchived,
  assertProjectPermission,
  holdsOrgWide,
  loadVisibleProject,
} from '../projects/project-access.js';
import { recordProjectActivity } from '../projects/project-activity.js';
import {
  parseEscalationNotify,
  parseHolidays,
  parseTicketMatch,
  parseWorkingHours,
  ticketMatchJson,
} from './sla-config.js';
import type { EscalationNotify, TicketMatch, WorkingHoursEntry } from './sla-config.js';

export interface SupportCategoryView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly active: boolean;
}

export interface SupportComponentView extends SupportCategoryView {
  readonly project: { readonly id: string; readonly code: string; readonly name: string } | null;
}

export interface BusinessCalendarView {
  readonly id: string;
  readonly name: string;
  readonly timeZone: string | null;
  readonly workingHours: readonly WorkingHoursEntry[];
  readonly holidays: readonly string[];
}

export interface SlaPolicyView {
  readonly id: string;
  readonly name: string;
  readonly priority: number;
  readonly match: TicketMatch;
  readonly firstResponseMinutes: number;
  readonly resolutionMinutes: number;
  readonly atRiskThresholdPercent: number;
  readonly businessCalendar: { readonly id: string; readonly name: string } | null;
  readonly pauseStatuses: readonly TicketStatus[];
  readonly active: boolean;
}

export interface EscalationRuleView {
  readonly id: string;
  readonly name: string;
  readonly slaPolicyId: string | null;
  readonly match: TicketMatch;
  readonly level: number;
  readonly trigger: EscalationTrigger;
  readonly threshold: number;
  readonly notify: EscalationNotify;
  readonly active: boolean;
}

export interface TaxonomyInput {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly active?: boolean | undefined;
}

export interface ComponentInput extends TaxonomyInput {
  readonly projectId?: string | null | undefined;
}

export interface CalendarInput {
  readonly name?: string | undefined;
  readonly timeZone?: string | null | undefined;
  readonly workingHours?: readonly WorkingHoursEntry[] | undefined;
  readonly holidays?: readonly string[] | undefined;
}

export interface TicketMatchInput {
  readonly severities?: readonly TicketSeverity[] | undefined;
  readonly priorities?: readonly TicketPriority[] | undefined;
  readonly projectIds?: readonly string[] | undefined;
  readonly categoryIds?: readonly string[] | undefined;
}

export interface SlaPolicyInput {
  readonly name?: string | undefined;
  readonly priority?: number | undefined;
  readonly match?: TicketMatchInput | undefined;
  readonly firstResponseMinutes?: number | undefined;
  readonly resolutionMinutes?: number | undefined;
  readonly atRiskThresholdPercent?: number | undefined;
  readonly businessCalendarId?: string | null | undefined;
  readonly pauseStatuses?: readonly TicketStatus[] | undefined;
  readonly active?: boolean | undefined;
}

export interface EscalationRuleInput {
  readonly name?: string | undefined;
  readonly slaPolicyId?: string | null | undefined;
  readonly match?: TicketMatchInput | undefined;
  readonly level?: number | undefined;
  readonly trigger?: EscalationTrigger | undefined;
  readonly threshold?: number | undefined;
  readonly notify?:
    | {
        readonly roles?: readonly string[] | undefined;
        readonly projectRoles?: readonly ProjectRole[] | undefined;
        readonly memberIds?: readonly string[] | undefined;
      }
    | undefined;
  readonly active?: boolean | undefined;
}

const PAUSABLE: readonly TicketStatus[] = [
  'TRIAGED',
  'IN_PROGRESS',
  'ESCALATED',
  'WAITING_FOR_DEVELOPMENT',
  'WAITING_FOR_CUSTOMER',
];
const MAX_CONFIG_ROWS = 500;

const policySelect = {
  id: true,
  name: true,
  priority: true,
  match: true,
  firstResponseMinutes: true,
  resolutionMinutes: true,
  atRiskThresholdPercent: true,
  pauseStatuses: true,
  active: true,
  businessCalendar: { select: { id: true, name: true } },
} satisfies Prisma.SlaPolicySelect;

const componentSelect = {
  id: true,
  name: true,
  description: true,
  active: true,
  project: { select: { id: true, code: true, name: true } },
} satisfies Prisma.SupportComponentSelect;

const ruleSelect = {
  id: true,
  name: true,
  slaPolicyId: true,
  match: true,
  level: true,
  trigger: true,
  threshold: true,
  notify: true,
  active: true,
} satisfies Prisma.EscalationRuleSelect;

const calendarSelect = {
  id: true,
  name: true,
  timeZone: true,
  workingHours: true,
  holidays: true,
} satisfies Prisma.BusinessCalendarSelect;

type PolicyRow = Prisma.SlaPolicyGetPayload<{ select: typeof policySelect }>;
type RuleRow = Prisma.EscalationRuleGetPayload<{ select: typeof ruleSelect }>;
type CalendarRow = Prisma.BusinessCalendarGetPayload<{ select: typeof calendarSelect }>;

const toPolicy = (row: PolicyRow): SlaPolicyView => ({
  id: row.id,
  name: row.name,
  priority: row.priority,
  match: parseTicketMatch(row.match),
  firstResponseMinutes: row.firstResponseMinutes,
  resolutionMinutes: row.resolutionMinutes,
  atRiskThresholdPercent: row.atRiskThresholdPercent,
  businessCalendar: row.businessCalendar,
  pauseStatuses: row.pauseStatuses,
  active: row.active,
});

const toRule = (row: RuleRow): EscalationRuleView => ({
  id: row.id,
  name: row.name,
  slaPolicyId: row.slaPolicyId,
  match: parseTicketMatch(row.match),
  level: row.level,
  trigger: row.trigger,
  threshold: row.threshold,
  notify: parseEscalationNotify(row.notify),
  active: row.active,
});

const toCalendar = (row: CalendarRow): BusinessCalendarView => ({
  id: row.id,
  name: row.name,
  timeZone: row.timeZone,
  workingHours: parseWorkingHours(row.workingHours),
  holidays: parseHolidays(row.holidays),
});

/**
 * Support configuration: taxonomies (categories, components), business calendars, SLA policies and
 * escalation rules. Reading active categories and components is open to everyone who may report a
 * ticket (the create form needs them); everything else needs `support.config` at ORG scope. Every
 * change is audited. Rows are deactivated, never deleted, so ticket history keeps its references.
 */
export class SupportConfigService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  // ---- Categories ----

  async listCategories(action: ActionContext, includeInactive: boolean): Promise<SupportCategoryView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'support.create');
    const all = includeInactive && this.isAdmin(action);
    return this.db.supportCategory.findMany({
      where: { organizationId, ...(all ? {} : { active: true }) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_CONFIG_ROWS,
      select: { id: true, name: true, description: true, active: true },
    });
  }

  async createCategory(action: ActionContext, input: TaxonomyInput & { name: string }): Promise<SupportCategoryView> {
    const organizationId = this.admin(action);
    return this.write('A category with this name already exists.', async (tx) => {
      const row = await tx.supportCategory.create({
        data: {
          organizationId,
          name: input.name,
          description: input.description ?? null,
          active: input.active ?? true,
        },
        select: { id: true, name: true, description: true, active: true },
      });
      await this.audit(tx, action, organizationId, 'support.category.created', 'support_category', row.id, {
        name: row.name,
      });
      return row;
    });
  }

  async updateCategory(action: ActionContext, categoryId: string, input: TaxonomyInput): Promise<SupportCategoryView> {
    const organizationId = this.admin(action);
    return this.write('A category with this name already exists.', async (tx) => {
      const data = taxonomyData(input);
      const updated = await tx.supportCategory.updateManyAndReturn({
        where: { organizationId, id: categoryId },
        data,
        select: { id: true, name: true, description: true, active: true },
      });
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError('Category');
      }
      await this.audit(tx, action, organizationId, 'support.category.updated', 'support_category', row.id, {
        fields: Object.keys(data).sort(),
      });
      return row;
    });
  }

  // ---- Components ----

  async listComponents(
    action: ActionContext,
    filter: { readonly projectId?: string | undefined; readonly includeInactive: boolean },
  ): Promise<SupportComponentView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    assertPermission(action.principal, 'support.create');
    const admin = this.isAdmin(action);
    if (filter.projectId !== undefined && !admin) {
      await loadVisibleProject(this.db, action, organizationId, filter.projectId);
    }
    const all = filter.includeInactive && admin;
    // Without a project, non-admins only get global components (project component names stay with the project).
    const projectScope =
      filter.projectId !== undefined
        ? { OR: [{ projectId: null }, { projectId: filter.projectId }] }
        : admin
          ? {}
          : { projectId: null };
    return this.db.supportComponent.findMany({
      where: {
        organizationId,
        ...(all ? {} : { active: true }),
        ...projectScope,
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_CONFIG_ROWS,
      select: componentSelect,
    });
  }

  async createComponent(
    action: ActionContext,
    input: ComponentInput & { name: string },
  ): Promise<SupportComponentView> {
    const organizationId = this.admin(action);
    return this.write('A component with this name already exists.', async (tx) => {
      await assertProjects(tx, organizationId, input.projectId == null ? [] : [input.projectId]);
      const row = await tx.supportComponent.create({
        data: {
          organizationId,
          name: input.name,
          description: input.description ?? null,
          projectId: input.projectId ?? null,
          active: input.active ?? true,
        },
        select: componentSelect,
      });
      await this.audit(tx, action, organizationId, 'support.component.created', 'support_component', row.id, {
        name: row.name,
        projectId: input.projectId ?? null,
      });
      return row;
    });
  }

  async updateComponent(
    action: ActionContext,
    componentId: string,
    input: ComponentInput,
  ): Promise<SupportComponentView> {
    const organizationId = this.admin(action);
    return this.write('A component with this name already exists.', async (tx) => {
      const data: Prisma.SupportComponentUncheckedUpdateManyInput = taxonomyData(input);
      if (input.projectId !== undefined) {
        await assertProjects(tx, organizationId, input.projectId === null ? [] : [input.projectId]);
        data.projectId = input.projectId;
      }
      const updated = await tx.supportComponent.updateManyAndReturn({
        where: { organizationId, id: componentId },
        data,
        select: componentSelect,
      });
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError('Component');
      }
      await this.audit(tx, action, organizationId, 'support.component.updated', 'support_component', row.id, {
        fields: Object.keys(data).sort(),
      });
      return row;
    });
  }

  // ---- Business calendars ----

  async listCalendars(action: ActionContext): Promise<BusinessCalendarView[]> {
    const organizationId = this.admin(action);
    const rows = await this.db.businessCalendar.findMany({
      where: { organizationId },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: MAX_CONFIG_ROWS,
      select: calendarSelect,
    });
    return rows.map(toCalendar);
  }

  async createCalendar(
    action: ActionContext,
    input: CalendarInput & { name: string; workingHours: readonly WorkingHoursEntry[] },
  ): Promise<BusinessCalendarView> {
    const organizationId = this.admin(action);
    assertTimeZone(input.timeZone ?? null);
    return this.write('A calendar with this name already exists.', async (tx) => {
      const row = await tx.businessCalendar.create({
        data: {
          organizationId,
          name: input.name,
          timeZone: input.timeZone ?? null,
          workingHours: workingHoursJson(input.workingHours),
          holidays: holidaysJson(input.holidays ?? []),
        },
        select: calendarSelect,
      });
      await this.audit(tx, action, organizationId, 'support.calendar.created', 'business_calendar', row.id, {
        name: row.name,
      });
      return toCalendar(row);
    });
  }

  async updateCalendar(action: ActionContext, calendarId: string, input: CalendarInput): Promise<BusinessCalendarView> {
    const organizationId = this.admin(action);
    assertTimeZone(input.timeZone ?? null);
    return this.write('A calendar with this name already exists.', async (tx) => {
      const data: Prisma.BusinessCalendarUncheckedUpdateManyInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.timeZone !== undefined) data.timeZone = input.timeZone;
      if (input.workingHours !== undefined) data.workingHours = workingHoursJson(input.workingHours);
      if (input.holidays !== undefined) data.holidays = holidaysJson(input.holidays);
      const updated = await tx.businessCalendar.updateManyAndReturn({
        where: { organizationId, id: calendarId },
        data,
        select: calendarSelect,
      });
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError('Calendar');
      }
      await this.audit(tx, action, organizationId, 'support.calendar.updated', 'business_calendar', row.id, {
        fields: Object.keys(data).sort(),
      });
      return toCalendar(row);
    });
  }

  // ---- SLA policies ----

  async listPolicies(action: ActionContext): Promise<SlaPolicyView[]> {
    const organizationId = this.admin(action);
    const rows = await this.db.slaPolicy.findMany({
      where: { organizationId },
      orderBy: [{ priority: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: MAX_CONFIG_ROWS,
      select: policySelect,
    });
    return rows.map(toPolicy);
  }

  async createPolicy(
    action: ActionContext,
    input: SlaPolicyInput & { name: string; priority: number; firstResponseMinutes: number; resolutionMinutes: number },
  ): Promise<SlaPolicyView> {
    const organizationId = this.admin(action);
    return this.write('An SLA policy with this name already exists.', async (tx) => {
      const match = await matchJson(tx, organizationId, input.match ?? {});
      assertMinutes(input.firstResponseMinutes, input.resolutionMinutes);
      const calendarId = input.businessCalendarId ?? null;
      await assertCalendar(tx, organizationId, calendarId);
      const row = await tx.slaPolicy.create({
        data: {
          organizationId,
          name: input.name,
          priority: input.priority,
          match,
          firstResponseMinutes: input.firstResponseMinutes,
          resolutionMinutes: input.resolutionMinutes,
          atRiskThresholdPercent: input.atRiskThresholdPercent ?? 75,
          businessHoursOnly: calendarId !== null,
          businessCalendarId: calendarId,
          pauseStatuses: pauseStatuses(input.pauseStatuses ?? ['WAITING_FOR_CUSTOMER']),
          active: input.active ?? true,
        },
        select: policySelect,
      });
      await this.audit(tx, action, organizationId, 'support.sla_policy.created', 'sla_policy', row.id, {
        name: row.name,
        priority: row.priority,
        firstResponseMinutes: row.firstResponseMinutes,
        resolutionMinutes: row.resolutionMinutes,
        businessCalendarId: calendarId,
      });
      return toPolicy(row);
    });
  }

  /**
   * Policy edits apply to open tickets governed by the policy at the next SLA sweep (due dates are
   * recomputed from each ticket's original start); conditions already recorded stay recorded.
   */
  async updatePolicy(action: ActionContext, policyId: string, input: SlaPolicyInput): Promise<SlaPolicyView> {
    const organizationId = this.admin(action);
    return this.write('An SLA policy with this name already exists.', async (tx) => {
      const current = await tx.slaPolicy.findFirst({
        where: { organizationId, id: policyId },
        select: { firstResponseMinutes: true, resolutionMinutes: true },
      });
      if (current === null) {
        throw new NotFoundError('SLA policy');
      }
      assertMinutes(
        input.firstResponseMinutes ?? current.firstResponseMinutes,
        input.resolutionMinutes ?? current.resolutionMinutes,
      );
      const data: Prisma.SlaPolicyUncheckedUpdateManyInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.priority !== undefined) data.priority = input.priority;
      if (input.match !== undefined) data.match = await matchJson(tx, organizationId, input.match);
      if (input.firstResponseMinutes !== undefined) data.firstResponseMinutes = input.firstResponseMinutes;
      if (input.resolutionMinutes !== undefined) data.resolutionMinutes = input.resolutionMinutes;
      if (input.atRiskThresholdPercent !== undefined) data.atRiskThresholdPercent = input.atRiskThresholdPercent;
      if (input.businessCalendarId !== undefined) {
        await assertCalendar(tx, organizationId, input.businessCalendarId);
        data.businessCalendarId = input.businessCalendarId;
        data.businessHoursOnly = input.businessCalendarId !== null;
      }
      if (input.pauseStatuses !== undefined) data.pauseStatuses = pauseStatuses(input.pauseStatuses);
      if (input.active !== undefined) data.active = input.active;
      const updated = await tx.slaPolicy.updateManyAndReturn({
        where: { organizationId, id: policyId },
        data,
        select: policySelect,
      });
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError('SLA policy');
      }
      await this.audit(tx, action, organizationId, 'support.sla_policy.updated', 'sla_policy', row.id, {
        fields: Object.keys(data).sort(),
      });
      return toPolicy(row);
    });
  }

  // ---- Escalation rules ----

  async listRules(action: ActionContext): Promise<EscalationRuleView[]> {
    const organizationId = this.admin(action);
    const rows = await this.db.escalationRule.findMany({
      where: { organizationId },
      orderBy: [{ level: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      take: MAX_CONFIG_ROWS,
      select: ruleSelect,
    });
    return rows.map(toRule);
  }

  async createRule(
    action: ActionContext,
    input: EscalationRuleInput & { name: string; level: number; trigger: EscalationTrigger; threshold: number },
  ): Promise<EscalationRuleView> {
    const organizationId = this.admin(action);
    return this.write('An escalation rule with this name already exists.', async (tx) => {
      await assertPolicy(tx, organizationId, input.slaPolicyId ?? null);
      const row = await tx.escalationRule.create({
        data: {
          organizationId,
          name: input.name,
          slaPolicyId: input.slaPolicyId ?? null,
          match: await matchJson(tx, organizationId, input.match ?? {}),
          level: input.level,
          trigger: input.trigger,
          threshold: assertThreshold(input.trigger, input.threshold),
          notify: await notifyJson(tx, organizationId, input.notify ?? {}),
          active: input.active ?? true,
        },
        select: ruleSelect,
      });
      await this.audit(tx, action, organizationId, 'support.escalation_rule.created', 'escalation_rule', row.id, {
        name: row.name,
        level: row.level,
        trigger: row.trigger,
        threshold: row.threshold,
      });
      return toRule(row);
    });
  }

  async updateRule(action: ActionContext, ruleId: string, input: EscalationRuleInput): Promise<EscalationRuleView> {
    const organizationId = this.admin(action);
    return this.write('An escalation rule with this name already exists.', async (tx) => {
      const current = await tx.escalationRule.findFirst({
        where: { organizationId, id: ruleId },
        select: { trigger: true, threshold: true },
      });
      if (current === null) {
        throw new NotFoundError('Escalation rule');
      }
      const data: Prisma.EscalationRuleUncheckedUpdateManyInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.slaPolicyId !== undefined) {
        await assertPolicy(tx, organizationId, input.slaPolicyId);
        data.slaPolicyId = input.slaPolicyId;
      }
      if (input.match !== undefined) data.match = await matchJson(tx, organizationId, input.match);
      if (input.level !== undefined) data.level = input.level;
      if (input.trigger !== undefined || input.threshold !== undefined) {
        data.trigger = input.trigger ?? current.trigger;
        data.threshold = assertThreshold(input.trigger ?? current.trigger, input.threshold ?? current.threshold);
      }
      if (input.notify !== undefined) data.notify = await notifyJson(tx, organizationId, input.notify);
      if (input.active !== undefined) data.active = input.active;
      const updated = await tx.escalationRule.updateManyAndReturn({
        where: { organizationId, id: ruleId },
        data,
        select: ruleSelect,
      });
      const row = updated[0];
      if (row === undefined) {
        throw new NotFoundError('Escalation rule');
      }
      await this.audit(tx, action, organizationId, 'support.escalation_rule.updated', 'escalation_rule', row.id, {
        fields: Object.keys(data).sort(),
      });
      return toRule(row);
    });
  }

  // ---- Project support team ----

  /**
   * Sets the team new tickets of a project are routed to (`project.manage` on the project). The
   * project version is the concurrency token. Audited and recorded on the project timeline.
   */
  async setProjectSupportTeam(
    action: ActionContext,
    projectId: string,
    expectedVersion: number,
    teamId: string | null,
  ): Promise<{
    readonly supportTeam: { readonly id: string; readonly name: string } | null;
    readonly version: number;
  }> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const project = await loadVisibleProject(tx, action, organizationId, projectId);
      assertProjectPermission(action, 'project.manage', project);
      assertNotArchived(project);
      const current = await tx.project.findFirstOrThrow({
        where: { organizationId, id: project.id },
        select: { supportTeamId: true },
      });
      let team: { id: string; name: string } | null = null;
      if (teamId !== null) {
        const found = await tx.team.findFirst({
          where: { organizationId, id: teamId },
          select: { id: true, name: true, archivedAt: true },
        });
        if (found === null) {
          throw new NotFoundError('Team');
        }
        if (found.archivedAt !== null) {
          throw new InvalidInputError('teamId', 'Archived teams cannot support projects.');
        }
        team = { id: found.id, name: found.name };
      }
      if (current.supportTeamId === teamId) {
        return { supportTeam: team, version: project.row.version };
      }
      const result = await tx.project.updateMany({
        where: { organizationId, id: project.id, version: expectedVersion },
        data: { supportTeamId: teamId, version: { increment: 1 } },
      });
      if (result.count === 0) {
        throw new VersionConflictError('The project');
      }
      await recordAudit(tx, organizationId, {
        action: 'project.support_team_changed',
        entityType: 'project',
        entityId: project.id,
        actor: userActor(action),
        metadata: { fromTeamId: current.supportTeamId, toTeamId: teamId },
        context: action.request,
      });
      await recordProjectActivity(tx, organizationId, project.id, action.principal.memberId, {
        source: 'PROJECT',
        type: 'project.support_team_changed',
        entityType: 'project',
        entityId: project.id,
        summaryParams: { teamName: team?.name ?? null },
      });
      return { supportTeam: team, version: expectedVersion + 1 };
    });
  }

  // ---- Helpers ----

  private isAdmin(action: ActionContext): boolean {
    return holdsOrgWide(action.principal, 'support.config');
  }

  private admin(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!this.isAdmin(action)) {
      throw new ForbiddenError();
    }
    return organizationId;
  }

  private async audit(
    db: TenantDb,
    action: ActionContext,
    organizationId: string,
    auditAction: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonObject,
  ): Promise<void> {
    await recordAudit(db, organizationId, {
      action: auditAction,
      entityType,
      entityId,
      actor: userActor(action),
      metadata,
      context: action.request,
    });
  }

  private async write<T>(conflictMessage: string, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(fn);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(conflictMessage);
      }
      throw error;
    }
  }
}

function taxonomyData(input: TaxonomyInput): { name?: string; description?: string | null; active?: boolean } {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.active === undefined ? {} : { active: input.active }),
  };
}

function assertTimeZone(timeZone: string | null): void {
  if (timeZone !== null && !isValidTimeZone(timeZone)) {
    throw new InvalidInputError('timeZone', 'Unknown time zone.');
  }
}

function assertMinutes(firstResponse: number, resolution: number): void {
  if (firstResponse > resolution) {
    throw new InvalidInputError(
      'firstResponseMinutes',
      'The first-response target cannot exceed the resolution target.',
    );
  }
}

function assertThreshold(trigger: EscalationTrigger, threshold: number): number {
  if (trigger === 'RESOLUTION_ELAPSED_PERCENT' && (threshold < 1 || threshold > 1000)) {
    throw new InvalidInputError('threshold', 'Use a percentage between 1 and 1000.');
  }
  return threshold;
}

function pauseStatuses(statuses: readonly TicketStatus[]): TicketStatus[] {
  for (const status of statuses) {
    if (!PAUSABLE.includes(status)) {
      throw new InvalidInputError('pauseStatuses', `${status} cannot pause the SLA clock.`);
    }
  }
  return [...new Set(statuses)];
}

function workingHoursJson(entries: readonly WorkingHoursEntry[]): Prisma.InputJsonArray {
  const parsed = parseWorkingHours(entries);
  if (parsed.length !== entries.length) {
    throw new InvalidInputError('workingHours', 'Use at most one window per weekday, with the end after the start.');
  }
  return parsed.map((entry) => ({ weekday: entry.weekday, start: entry.start, end: entry.end }));
}

function holidaysJson(holidays: readonly string[]): Prisma.InputJsonArray {
  return parseHolidays(holidays);
}

async function assertProjects(db: TenantDb, organizationId: string, projectIds: readonly string[]): Promise<void> {
  const ids = [...new Set(projectIds)];
  if (ids.length === 0) return;
  const found = await db.project.count({ where: { organizationId, id: { in: ids } } });
  if (found !== ids.length) {
    throw new NotFoundError('Project');
  }
}

async function assertCalendar(db: TenantDb, organizationId: string, calendarId: string | null): Promise<void> {
  if (calendarId === null) return;
  const found = await db.businessCalendar.count({ where: { organizationId, id: calendarId } });
  if (found === 0) {
    throw new NotFoundError('Calendar');
  }
}

async function assertPolicy(db: TenantDb, organizationId: string, policyId: string | null): Promise<void> {
  if (policyId === null) return;
  const found = await db.slaPolicy.count({ where: { organizationId, id: policyId } });
  if (found === 0) {
    throw new NotFoundError('SLA policy');
  }
}

async function matchJson(
  db: TenantDb,
  organizationId: string,
  input: TicketMatchInput,
): Promise<Prisma.InputJsonObject> {
  const match: TicketMatch = {
    severities: [...new Set(input.severities ?? [])],
    priorities: [...new Set(input.priorities ?? [])],
    projectIds: [...new Set(input.projectIds ?? [])],
    categoryIds: [...new Set(input.categoryIds ?? [])],
  };
  await assertProjects(db, organizationId, match.projectIds);
  if (match.categoryIds.length > 0) {
    const found = await db.supportCategory.count({ where: { organizationId, id: { in: [...match.categoryIds] } } });
    if (found !== match.categoryIds.length) {
      throw new NotFoundError('Category');
    }
  }
  return ticketMatchJson(match);
}

async function notifyJson(
  db: TenantDb,
  organizationId: string,
  input: NonNullable<EscalationRuleInput['notify']>,
): Promise<Prisma.InputJsonObject> {
  const roles = [...new Set(input.roles ?? [])];
  if (roles.length > 0) {
    const found = await db.role.count({ where: { organizationId, key: { in: roles } } });
    if (found !== roles.length) {
      throw new InvalidInputError('notify.roles', 'Unknown role.');
    }
  }
  const memberIds = [...new Set(input.memberIds ?? [])];
  if (memberIds.length > 0) {
    const found = await db.organizationMember.count({ where: { organizationId, id: { in: memberIds } } });
    if (found !== memberIds.length) {
      throw new NotFoundError('Member');
    }
  }
  return { roles, projectRoles: [...new Set(input.projectRoles ?? [])], memberIds };
}
