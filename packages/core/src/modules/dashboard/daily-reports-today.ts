import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { zonedInstant } from '../attendance/engine/time.js';
import { hasPermission } from '../authorization/effective-permissions.js';
import { canAccessResource } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { fromDateOnly, localToday, minutesOf, toDateOnly } from '../projects/business-date.js';
import { parseDailyReportPolicy } from '../projects/daily-report-policy.js';
import { computeMissingReports, REPORTING_STATUSES, submittedKey } from '../projects/missing-reports.js';
import type { ExpectedReporter, MissingReportResult } from '../projects/missing-reports.js';
import { projectAccessSelect, projectFacts } from '../projects/project-access.js';
import type { ProjectAccessRow } from '../projects/project-access.js';
import { projectLink } from './links.js';
import type { DashboardLink } from './links.js';

/** Most projects one dashboard evaluates for missing reports (bounded work per request). */
export const MISSING_REPORT_PROJECT_CAP = 200;

/**
 * Today's expected, missing and pending daily reports for many projects at once — the same rule as
 * the project's missing-reports endpoint (`computeMissingReports`) with the range "today" in each
 * project's zone. Three queries regardless of the number of projects.
 */
export async function missingReportsToday(
  db: TenantDb,
  organizationId: string,
  projects: readonly ProjectAccessRow[],
  now: Date,
): Promise<Map<string, MissingReportResult>> {
  const result = new Map<string, MissingReportResult>();
  const reporting = projects
    .filter((project) => REPORTING_STATUSES.includes(project.status))
    .filter((project) => parseDailyReportPolicy(project.dailyReportPolicy).required)
    .slice(0, MISSING_REPORT_PROJECT_CAP);
  if (reporting.length === 0) {
    return result;
  }
  const organization = await db.organization.findFirstOrThrow({
    where: { id: organizationId },
    select: { timeZone: true, workWeek: true },
  });
  const zoneOf = (project: ProjectAccessRow): string => project.timeZone ?? organization.timeZone;
  const todays = [...new Set(reporting.map((project) => localToday(now, zoneOf(project))))];
  const ids = reporting.map((project) => project.id);
  const members = await db.projectMember.findMany({
    where: { organizationId, projectId: { in: ids } },
    select: {
      projectId: true,
      profileId: true,
      projectRole: true,
      startDate: true,
      endDate: true,
      profile: {
        select: { memberId: true, fullName: true, employmentStatus: true, member: { select: { status: true } } },
      },
    },
  });
  const submitted = await db.dailyReport.findMany({
    where: { organizationId, projectId: { in: ids }, reportDate: { in: todays.map(fromDateOnly) } },
    select: { projectId: true, reporterProfileId: true, reportDate: true },
  });
  for (const project of reporting) {
    const timeZone = zoneOf(project);
    const today = localToday(now, timeZone);
    const reporters: ExpectedReporter[] = members
      .filter((member) => member.projectId === project.id)
      .map((member) => ({
        profileId: member.profileId,
        memberId: member.profile.memberId,
        fullName: member.profile.fullName,
        projectRole: member.projectRole,
        startDate: toDateOnly(member.startDate) ?? today,
        endDate: toDateOnly(member.endDate),
        active: member.profile.member.status === 'ACTIVE' && member.profile.employmentStatus === 'ACTIVE',
      }));
    const keys = new Set(
      submitted
        .filter((report) => report.projectId === project.id)
        .map((report) => submittedKey(report.reporterProfileId, toDateOnly(report.reportDate) ?? '')),
    );
    result.set(
      project.id,
      computeMissingReports({
        status: project.status,
        projectStartDate: toDateOnly(project.startDate),
        policy: parseDailyReportPolicy(project.dailyReportPolicy),
        workWeek: organization.workWeek,
        timeZone,
        now,
        reporters,
        submitted: keys,
        from: today,
        to: today,
      }),
    );
  }
  return result;
}

export interface OwnReportDue {
  readonly projectId: string;
  readonly code: string;
  readonly name: string;
  /** The project's local date the report is for. */
  readonly date: string;
  /** The due time has passed. */
  readonly overdue: boolean;
  readonly dueAt: Date;
  readonly link: DashboardLink;
}

const OWN_PROJECTS_CAP = 50;

/** Today's reports the caller still owes on projects they report for (the missing-reports rule). */
export async function ownReportsDue(
  db: TenantDb,
  principal: Principal,
  organizationId: string,
  now: Date,
): Promise<OwnReportDue[]> {
  if (!hasPermission(principal.permissions, 'daily_report.submit')) {
    return [];
  }
  const profile = await db.employeeProfile.findFirst({
    where: { organizationId, memberId: principal.memberId },
    select: { id: true },
  });
  if (profile === null) {
    return [];
  }
  const rows = await db.project.findMany({
    where: {
      organizationId,
      status: { in: [...REPORTING_STATUSES] },
      members: { some: { profileId: profile.id } },
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    take: OWN_PROJECTS_CAP,
    select: projectAccessSelect,
  });
  const submittable = rows.filter((row) =>
    canAccessResource(principal, 'daily_report.submit', projectFacts(organizationId, row)),
  );
  const results = await missingReportsToday(db, organizationId, submittable, now);
  const items: OwnReportDue[] = [];
  for (const row of submittable) {
    const result = results.get(row.id);
    if (result === undefined) continue;
    const overdue = result.missing.some((entry) => entry.reporter.profileId === profile.id);
    const pending = result.pendingToday.some((entry) => entry.reporter.profileId === profile.id);
    if (!overdue && !pending) continue;
    const policy = parseDailyReportPolicy(row.dailyReportPolicy);
    const timeZone = row.timeZone ?? (await organizationTimeZone(db, organizationId));
    items.push({
      projectId: row.id,
      code: row.code,
      name: row.name,
      date: result.today,
      overdue,
      dueAt: zonedInstant(result.today, minutesOf(policy.dueLocalTime), timeZone),
      link: projectLink(row.id, 'reports'),
    });
  }
  return items;
}

async function organizationTimeZone(db: TenantDb, organizationId: string): Promise<string> {
  const organization = await db.organization.findFirstOrThrow({
    where: { id: organizationId },
    select: { timeZone: true },
  });
  return organization.timeZone;
}
