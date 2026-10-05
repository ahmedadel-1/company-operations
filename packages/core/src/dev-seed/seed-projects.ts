import type {
  CustomerType,
  DailyReportStatus,
  Prisma,
  ProjectHealth,
  ProjectRole,
  ProjectStatus,
  WorkLocationType,
} from '@company-ops/db';

import { recordAudit } from '../platform/audit/audit-writer.js';
import { nextCounterValue } from '../platform/db/sql/counters.js';
import { recordProjectActivity } from '../modules/projects/project-activity.js';

/**
 * Development project data (ROADMAP P2): customers, work locations, projects with members, linked
 * locations and a few submitted daily reports on fixed dates. The `field` and `employee` demo users
 * are deliberately left unassigned so assignment and access can be demonstrated end to end.
 */
interface DemoCustomer {
  readonly name: string;
  readonly type: CustomerType;
  readonly contactName: string;
  readonly contactEmail: string;
}

interface DemoLocation {
  readonly name: string;
  readonly type: WorkLocationType;
  readonly latitude: number;
  readonly longitude: number;
  readonly radius: number;
  readonly address: string;
}

interface DemoProject {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly customer: string;
  readonly status: ProjectStatus;
  readonly health: ProjectHealth;
  readonly healthNote: string | null;
  readonly startDate: string;
  readonly targetEndDate: string | null;
  readonly projectManager: string;
  readonly technicalManager: string;
  readonly reportsRequired: boolean;
  readonly members: readonly { readonly number: string; readonly role: ProjectRole }[];
  readonly locations: readonly string[];
  readonly reports: readonly {
    readonly number: string;
    readonly date: string;
    readonly status: DailyReportStatus;
    readonly work: string;
  }[];
}

export const DEMO_CUSTOMERS: readonly DemoCustomer[] = [
  {
    name: 'Ministry of Transport',
    type: 'GOVERNMENT',
    contactName: 'Eng. Samir Fawzy',
    contactEmail: 'it@mot.example.test',
  },
  {
    name: 'Nile Retail Group',
    type: 'PRIVATE',
    contactName: 'Mai Hegazy',
    contactEmail: 'ops@nileretail.example.test',
  },
  { name: 'Internal IT', type: 'INTERNAL', contactName: 'Olivia Admin', contactEmail: 'it@demo.company-ops.test' },
];

export const DEMO_LOCATIONS: readonly DemoLocation[] = [
  { name: 'Cairo HQ', type: 'OFFICE', latitude: 30.0444, longitude: 31.2357, radius: 200, address: 'Downtown, Cairo' },
  {
    name: 'Smart Village Site',
    type: 'PROJECT_SITE',
    latitude: 30.071,
    longitude: 31.017,
    radius: 300,
    address: 'Smart Village, Giza',
  },
  {
    name: 'Alexandria Customer Site',
    type: 'CUSTOMER_SITE',
    latitude: 31.2001,
    longitude: 29.9187,
    radius: 250,
    address: 'Smouha, Alexandria',
  },
];

export const DEMO_PROJECTS: readonly DemoProject[] = [
  {
    code: 'TMP',
    name: 'Traffic Management Platform',
    description: 'Operations platform for the national traffic control centers.',
    customer: 'Ministry of Transport',
    status: 'ACTIVE',
    health: 'HEALTHY',
    healthNote: null,
    startDate: '2026-09-01',
    targetEndDate: '2027-06-30',
    projectManager: 'EMP-00013',
    technicalManager: 'EMP-00006',
    reportsRequired: true,
    members: [
      { number: 'EMP-00014', role: 'DEVELOPER' },
      { number: 'EMP-00015', role: 'DEVELOPER' },
      { number: 'EMP-00024', role: 'FIELD' },
      { number: 'EMP-00025', role: 'FIELD' },
    ],
    locations: ['Smart Village Site', 'Cairo HQ'],
    reports: [
      {
        number: 'EMP-00024',
        date: '2026-09-27',
        status: 'NORMAL',
        work: 'Checked the control room links; all sites online.',
      },
      {
        number: 'EMP-00025',
        date: '2026-09-27',
        status: 'DEGRADED',
        work: 'Camera feed at gate 3 intermittent; ticket raised.',
      },
      {
        number: 'EMP-00024',
        date: '2026-09-28',
        status: 'NORMAL',
        work: 'Routine inspection completed without findings.',
      },
    ],
  },
  {
    code: 'POS',
    name: 'Retail POS Rollout',
    description: 'Point-of-sale rollout to 40 branches.',
    customer: 'Nile Retail Group',
    status: 'PLANNING',
    health: 'NEEDS_ATTENTION',
    healthNote: 'Hardware delivery date not confirmed by the vendor.',
    startDate: '2026-11-01',
    targetEndDate: '2027-03-31',
    projectManager: 'EMP-00008',
    technicalManager: 'EMP-00006',
    reportsRequired: false,
    members: [
      { number: 'EMP-00009', role: 'DEVELOPER' },
      { number: 'EMP-00026', role: 'FIELD' },
    ],
    locations: ['Alexandria Customer Site'],
    reports: [],
  },
  {
    code: 'IHD',
    name: 'Internal Helpdesk Upgrade',
    description: 'Upgrade of the internal helpdesk tooling.',
    customer: 'Internal IT',
    status: 'MAINTENANCE',
    health: 'HEALTHY',
    healthNote: null,
    startDate: '2026-03-01',
    targetEndDate: null,
    projectManager: 'EMP-00041',
    technicalManager: 'EMP-00006',
    reportsRequired: false,
    members: [{ number: 'EMP-00019', role: 'SUPPORT' }],
    locations: ['Cairo HQ'],
    reports: [],
  },
];

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Idempotent: rows are matched by natural keys (customer/location name, project code, report date). */
export async function seedProjects(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<{ projectsCreated: number }> {
  const profiles = new Map(
    (
      await tx.employeeProfile.findMany({
        where: { organizationId },
        select: { id: true, employeeNumber: true, memberId: true },
      })
    ).map((row) => [row.employeeNumber, row]),
  );
  const profile = (number: string) => {
    const row = profiles.get(number);
    if (row === undefined) {
      throw new Error(`Seed employee ${number} is missing.`);
    }
    return row;
  };

  const customerIds = new Map<string, string>();
  for (const customer of DEMO_CUSTOMERS) {
    const row =
      (await tx.customer.findFirst({ where: { organizationId, name: customer.name }, select: { id: true } })) ??
      (await tx.customer.create({ data: { organizationId, ...customer }, select: { id: true } }));
    customerIds.set(customer.name, row.id);
  }

  const locationIds = new Map<string, string>();
  for (const location of DEMO_LOCATIONS) {
    const row =
      (await tx.workLocation.findFirst({ where: { organizationId, name: location.name }, select: { id: true } })) ??
      (await tx.workLocation.create({
        data: {
          organizationId,
          name: location.name,
          type: location.type,
          latitude: location.latitude,
          longitude: location.longitude,
          allowedRadiusMeters: location.radius,
          address: location.address,
        },
        select: { id: true },
      }));
    locationIds.set(location.name, row.id);
  }

  let projectsCreated = 0;
  for (const project of DEMO_PROJECTS) {
    let row = await tx.project.findFirst({ where: { organizationId, code: project.code }, select: { id: true } });
    if (row === null) {
      const number = Number(await nextCounterValue(tx, organizationId, 'PRJ'));
      row = await tx.project.create({
        data: {
          organizationId,
          number,
          code: project.code,
          name: project.name,
          description: project.description,
          customerId: customerIds.get(project.customer) ?? null,
          status: project.status,
          statusChangedAt: new Date(),
          health: project.health,
          healthNote: project.healthNote,
          startDate: day(project.startDate),
          targetEndDate: project.targetEndDate === null ? null : day(project.targetEndDate),
          projectManagerProfileId: profile(project.projectManager).id,
          technicalManagerProfileId: profile(project.technicalManager).id,
          dailyReportPolicy: {
            required: project.reportsRequired,
            weekdays: [],
            dueLocalTime: '18:00',
            reporterRoles: ['FIELD'],
          },
        },
        select: { id: true },
      });
      projectsCreated += 1;
      await recordAudit(tx, organizationId, {
        action: 'project.created',
        entityType: 'project',
        entityId: row.id,
        actor: { type: 'SYSTEM' },
        metadata: { source: 'dev-seed', code: project.code, number },
      });
      await recordProjectActivity(tx, organizationId, row.id, null, {
        source: 'PROJECT',
        type: 'project.created',
        entityType: 'project',
        entityId: row.id,
        summaryParams: { code: project.code, name: project.name },
      });
    }
    for (const member of project.members) {
      const person = profile(member.number);
      const existing = await tx.projectMember.findFirst({
        where: { organizationId, projectId: row.id, profileId: person.id },
        select: { id: true },
      });
      if (existing === null) {
        await tx.projectMember.create({
          data: {
            organizationId,
            projectId: row.id,
            profileId: person.id,
            projectRole: member.role,
            startDate: day(project.startDate),
          },
        });
      }
    }
    for (const name of project.locations) {
      const workLocationId = locationIds.get(name);
      if (workLocationId === undefined) {
        continue;
      }
      const existing = await tx.projectLocation.findFirst({
        where: { organizationId, projectId: row.id, workLocationId },
        select: { id: true },
      });
      if (existing === null) {
        await tx.projectLocation.create({ data: { organizationId, projectId: row.id, workLocationId } });
      }
    }
    for (const report of project.reports) {
      const reporter = profile(report.number);
      const existing = await tx.dailyReport.findFirst({
        where: { organizationId, projectId: row.id, reporterProfileId: reporter.id, reportDate: day(report.date) },
        select: { id: true },
      });
      if (existing !== null) {
        continue;
      }
      const number = Number(await nextCounterValue(tx, organizationId, 'DR'));
      const created = await tx.dailyReport.create({
        data: {
          organizationId,
          number,
          projectId: row.id,
          reporterProfileId: reporter.id,
          reportDate: day(report.date),
          systemStatus: report.status,
          workPerformed: report.work,
          submittedByMemberId: reporter.memberId,
          submittedAt: new Date(`${report.date}T15:00:00.000Z`),
        },
        select: { id: true },
      });
      await recordProjectActivity(tx, organizationId, row.id, reporter.memberId, {
        source: 'DAILY_REPORT',
        type: 'daily_report.submitted',
        entityType: 'daily_report',
        entityId: created.id,
        summaryParams: { number, reportDate: report.date, systemStatus: report.status },
      });
    }
  }
  return { projectsCreated };
}
