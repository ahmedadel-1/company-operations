import type { Prisma, TicketImpact, TicketPriority, TicketSeverity, TicketSource } from '@company-ops/db';

import { recordAudit } from '../platform/audit/audit-writer.js';
import { nextCounterValue } from '../platform/db/sql/counters.js';
import { policyClock } from '../modules/support/sla-config.js';
import { dueDates } from '../modules/support/sla-evaluator.js';

/**
 * Development support data (ROADMAP P3): categories, components, a business calendar, SLA policies,
 * an escalation rule, the support team of two projects and a few NEW tickets. Idempotent by natural
 * keys (names, ticket titles); existing rows are never changed. Seeded tickets start their SLA clock
 * at seed time; the worker's SLA sweep keeps their state current afterwards.
 */
export const DEMO_SUPPORT_TEAM = 'Support Tier 1';

const CATEGORIES = [
  { name: 'Hardware', description: 'Devices, cameras, servers and peripherals.' },
  { name: 'Software', description: 'Application errors and unexpected behaviour.' },
  { name: 'Network', description: 'Connectivity, VPN and links between sites.' },
  { name: 'Access', description: 'Accounts, permissions and passwords.' },
  { name: 'Other', description: null },
] as const;

const COMPONENTS: readonly { name: string; projectCode: string | null }[] = [
  { name: 'Control room dashboard', projectCode: 'TMP' },
  { name: 'Camera network', projectCode: 'TMP' },
  { name: 'Helpdesk portal', projectCode: 'IHD' },
  { name: 'Email and calendar', projectCode: null },
];

const CALENDAR = {
  name: 'Cairo business hours',
  // Sunday (7) to Thursday (4), 09:00-17:00 in the organization's zone.
  workingHours: [7, 1, 2, 3, 4].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  holidays: ['2026-10-06', '2027-01-07'],
};

const POLICIES: readonly {
  name: string;
  priority: number;
  severities: readonly TicketSeverity[];
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHours: boolean;
}[] = [
  {
    name: 'Critical (24x7)',
    priority: 10,
    severities: ['CRITICAL'],
    firstResponseMinutes: 30,
    resolutionMinutes: 240,
    businessHours: false,
  },
  {
    name: 'High (business hours)',
    priority: 20,
    severities: ['HIGH'],
    firstResponseMinutes: 120,
    resolutionMinutes: 960,
    businessHours: true,
  },
  {
    name: 'Standard (business hours)',
    priority: 100,
    severities: [],
    firstResponseMinutes: 480,
    resolutionMinutes: 2400,
    businessHours: true,
  },
];

const TICKETS: readonly {
  title: string;
  description: string;
  reporterNumber: string;
  projectCode: string;
  category: string;
  component: string | null;
  severity: TicketSeverity;
  priority: TicketPriority;
  impact: TicketImpact;
  source: TicketSource;
}[] = [
  {
    title: 'Gate 3 camera feed drops every few minutes',
    description: 'The camera at gate 3 loses its feed several times an hour since this morning.',
    reporterNumber: 'EMP-00025',
    projectCode: 'TMP',
    category: 'Hardware',
    component: 'Camera network',
    severity: 'HIGH',
    priority: 'P2',
    impact: 'SITE',
    source: 'FIELD',
  },
  {
    title: 'Helpdesk portal search returns no results',
    description: 'Searching tickets by keyword in the helpdesk portal always shows an empty list.',
    reporterNumber: 'EMP-00019',
    projectCode: 'IHD',
    category: 'Software',
    component: 'Helpdesk portal',
    severity: 'MEDIUM',
    priority: 'P3',
    impact: 'MULTIPLE_USERS',
    source: 'INTERNAL',
  },
];

export async function seedSupport(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<{ ticketsCreated: number }> {
  const team = await tx.team.findFirst({ where: { organizationId, name: DEMO_SUPPORT_TEAM }, select: { id: true } });
  const projects = new Map(
    (await tx.project.findMany({ where: { organizationId }, select: { id: true, code: true } })).map((row) => [
      row.code,
      row.id,
    ]),
  );
  if (team !== null) {
    for (const code of ['TMP', 'IHD']) {
      const projectId = projects.get(code);
      if (projectId === undefined) continue;
      const updated = await tx.project.updateMany({
        where: { organizationId, id: projectId, supportTeamId: null },
        data: { supportTeamId: team.id, version: { increment: 1 } },
      });
      if (updated.count > 0) {
        await recordAudit(tx, organizationId, {
          action: 'project.support_team_changed',
          entityType: 'project',
          entityId: projectId,
          actor: { type: 'SYSTEM' },
          metadata: { source: 'dev-seed', teamId: team.id },
        });
      }
    }
  }

  const categoryIds = new Map<string, string>();
  for (const category of CATEGORIES) {
    const row =
      (await tx.supportCategory.findFirst({ where: { organizationId, name: category.name }, select: { id: true } })) ??
      (await tx.supportCategory.create({ data: { organizationId, ...category }, select: { id: true } }));
    categoryIds.set(category.name, row.id);
  }

  const componentIds = new Map<string, string>();
  for (const component of COMPONENTS) {
    const row =
      (await tx.supportComponent.findFirst({
        where: { organizationId, name: component.name },
        select: { id: true },
      })) ??
      (await tx.supportComponent.create({
        data: {
          organizationId,
          name: component.name,
          projectId: component.projectCode === null ? null : (projects.get(component.projectCode) ?? null),
        },
        select: { id: true },
      }));
    componentIds.set(component.name, row.id);
  }

  const calendar =
    (await tx.businessCalendar.findFirst({ where: { organizationId, name: CALENDAR.name }, select: { id: true } })) ??
    (await tx.businessCalendar.create({
      data: { organizationId, name: CALENDAR.name, workingHours: CALENDAR.workingHours, holidays: CALENDAR.holidays },
      select: { id: true },
    }));

  const policyIds = new Map<string, string>();
  for (const policy of POLICIES) {
    const row =
      (await tx.slaPolicy.findFirst({ where: { organizationId, name: policy.name }, select: { id: true } })) ??
      (await tx.slaPolicy.create({
        data: {
          organizationId,
          name: policy.name,
          priority: policy.priority,
          match: policy.severities.length === 0 ? {} : { severities: [...policy.severities] },
          firstResponseMinutes: policy.firstResponseMinutes,
          resolutionMinutes: policy.resolutionMinutes,
          businessHoursOnly: policy.businessHours,
          businessCalendarId: policy.businessHours ? calendar.id : null,
        },
        select: { id: true },
      }));
    policyIds.set(policy.name, row.id);
  }
  const organization = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { timeZone: true },
  });
  const now = new Date();
  /** SLA columns of a NEW ticket created now under the seed policy for its severity. */
  const slaFor = async (severity: TicketSeverity) => {
    const seeded = POLICIES.find((p) => p.severities.length === 0 || p.severities.includes(severity));
    const id = seeded === undefined ? undefined : policyIds.get(seeded.name);
    if (id === undefined) return {};
    const row = await tx.slaPolicy.findFirstOrThrow({
      where: { organizationId, id },
      select: {
        id: true,
        name: true,
        firstResponseMinutes: true,
        resolutionMinutes: true,
        atRiskThresholdPercent: true,
        businessHoursOnly: true,
        pauseStatuses: true,
        businessCalendar: { select: { timeZone: true, workingHours: true, holidays: true } },
      },
    });
    const due = dueDates(policyClock(row, organization.timeZone), now, 0);
    return {
      slaPolicyId: row.id,
      slaStartedAt: now,
      firstResponseDueAt: due.firstResponseDueAt,
      resolutionDueAt: due.resolutionDueAt,
      firstResponseSlaState: 'ON_TRACK' as const,
      resolutionSlaState: 'ON_TRACK' as const,
    };
  };

  const ruleName = 'Critical: notify project managers at 50%';
  if (
    (await tx.escalationRule.findFirst({ where: { organizationId, name: ruleName }, select: { id: true } })) === null
  ) {
    await tx.escalationRule.create({
      data: {
        organizationId,
        name: ruleName,
        slaPolicyId: policyIds.get('Critical (24x7)') ?? null,
        level: 1,
        trigger: 'RESOLUTION_ELAPSED_PERCENT',
        threshold: 50,
        notify: { roles: ['TECHNICAL_MANAGER'], projectRoles: ['PROJECT_MANAGER'], memberIds: [] },
      },
    });
  }

  const reporters = new Map(
    (
      await tx.employeeProfile.findMany({
        where: { organizationId, employeeNumber: { in: TICKETS.map((ticket) => ticket.reporterNumber) } },
        select: { employeeNumber: true, memberId: true },
      })
    ).map((row) => [row.employeeNumber, row.memberId]),
  );
  let ticketsCreated = 0;
  for (const ticket of TICKETS) {
    const reporterMemberId = reporters.get(ticket.reporterNumber);
    const projectId = projects.get(ticket.projectCode);
    if (reporterMemberId === undefined || projectId === undefined) continue;
    const existing = await tx.supportTicket.findFirst({
      where: { organizationId, title: ticket.title },
      select: { id: true },
    });
    if (existing !== null) continue;
    const number = Number(await nextCounterValue(tx, organizationId, 'SUP'));
    const created = await tx.supportTicket.create({
      data: {
        organizationId,
        number,
        projectId,
        reporterMemberId,
        source: ticket.source,
        categoryId: categoryIds.get(ticket.category) ?? null,
        componentId: ticket.component === null ? null : (componentIds.get(ticket.component) ?? null),
        title: ticket.title,
        description: ticket.description,
        severity: ticket.severity,
        priority: ticket.priority,
        impact: ticket.impact,
        assignedTeamId: team?.id ?? null,
        ...(await slaFor(ticket.severity)),
      },
      select: { id: true },
    });
    await tx.supportTicketEvent.create({
      data: {
        organizationId,
        ticketId: created.id,
        actorMemberId: reporterMemberId,
        type: 'CREATED',
        toValue: { status: 'NEW' },
        metadata: {
          severity: ticket.severity,
          priority: ticket.priority,
          impact: ticket.impact,
          source: ticket.source,
          ...(team === null ? {} : { assignedTeamId: team.id }),
        },
      },
    });
    ticketsCreated += 1;
  }
  return { ticketsCreated };
}
