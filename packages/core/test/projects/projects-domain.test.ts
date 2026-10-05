import { describe, expect, it } from 'vitest';

import type { Principal } from '../../src/modules/authorization/policy.js';
import { canAccessResource, listScope } from '../../src/modules/authorization/policy.js';
import { computeEffectivePermissions } from '../../src/modules/authorization/effective-permissions.js';
import { addDays, daysBetween, isoWeekday, localMoment, localToday } from '../../src/modules/projects/business-date.js';
import { dailyReportFacts, dailyReportScopeWhere } from '../../src/modules/projects/daily-report.service.js';
import {
  DEFAULT_DAILY_REPORT_POLICY,
  effectiveWeekdays,
  parseDailyReportPolicy,
} from '../../src/modules/projects/daily-report-policy.js';
import type { DailyReportPolicy } from '../../src/modules/projects/daily-report-policy.js';
import { computeMissingReports, submittedKey } from '../../src/modules/projects/missing-reports.js';
import type { ExpectedReporter, MissingReportInput } from '../../src/modules/projects/missing-reports.js';
import { parseActivityPayload } from '../../src/modules/projects/project-activity.js';
import { projectFacts, projectScopeWhere } from '../../src/modules/projects/project-access.js';
import type { ProjectAccessRow } from '../../src/modules/projects/project-access.js';
import {
  ARCHIVABLE_STATUSES,
  canTransition,
  RESTORED_STATUS,
  STATUS_TRANSITIONS,
} from '../../src/modules/projects/project-lifecycle.js';

const ORG = '00000000-0000-7000-8000-000000000001';

describe('business dates (time zone, never server-local)', () => {
  it('computes the local date and minute of a UTC instant in the given zone', () => {
    const instant = new Date('2026-10-05T23:30:00.000Z');
    expect(localMoment(instant, 'Asia/Tokyo')).toEqual({ date: '2026-10-06', minutes: 8 * 60 + 30 });
    expect(localMoment(instant, 'America/Los_Angeles')).toEqual({ date: '2026-10-05', minutes: 16 * 60 + 30 });
    expect(localToday(instant, 'UTC')).toBe('2026-10-05');
  });

  it('handles midnight boundaries and DST changes', () => {
    // 2026-10-25 01:00 UTC: London leaves BST (01:59:59 BST -> 01:00 GMT).
    expect(localMoment(new Date('2026-10-24T23:00:00.000Z'), 'Europe/London')).toEqual({
      date: '2026-10-25',
      minutes: 0,
    });
    expect(localMoment(new Date('2026-10-25T01:30:00.000Z'), 'Europe/London')).toEqual({
      date: '2026-10-25',
      minutes: 90,
    });
    expect(localMoment(new Date('2026-10-25T23:59:00.000Z'), 'Europe/London').date).toBe('2026-10-25');
  });

  it('does calendar arithmetic without zone drift', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
    expect(daysBetween('2026-10-08', '2026-10-01')).toBe(-7);
    expect(isoWeekday('2026-10-04')).toBe(7); // Sunday
    expect(isoWeekday('2026-10-05')).toBe(1); // Monday
  });
});

describe('daily-report policy', () => {
  it('parses a valid stored policy and normalizes duplicates', () => {
    expect(
      parseDailyReportPolicy({
        required: true,
        weekdays: [3, 1, 1],
        dueLocalTime: '17:30',
        reporterRoles: ['FIELD', 'FIELD'],
      }),
    ).toEqual({ required: true, weekdays: [1, 3], dueLocalTime: '17:30', reporterRoles: ['FIELD'] });
  });

  it.each([
    null,
    'x',
    [],
    { required: 'yes', weekdays: [], dueLocalTime: '18:00', reporterRoles: ['FIELD'] },
    { required: true, weekdays: [8], dueLocalTime: '18:00', reporterRoles: ['FIELD'] },
    { required: true, weekdays: [], dueLocalTime: '24:00', reporterRoles: ['FIELD'] },
    { required: true, weekdays: [], dueLocalTime: '18:00', reporterRoles: ['ADMIN'] },
  ])('falls back to "not required" for malformed values (%j)', (value) => {
    expect(parseDailyReportPolicy(value)).toEqual(DEFAULT_DAILY_REPORT_POLICY);
    expect(parseDailyReportPolicy(value).required).toBe(false);
  });

  it('uses the organization work week when no weekdays are set', () => {
    expect([...effectiveWeekdays({ ...DEFAULT_DAILY_REPORT_POLICY, weekdays: [] }, [7, 1, 2, 3, 4])]).toEqual([
      7, 1, 2, 3, 4,
    ]);
    expect([...effectiveWeekdays({ ...DEFAULT_DAILY_REPORT_POLICY, weekdays: [6] }, [7, 1, 2, 3, 4])]).toEqual([6]);
  });
});

describe('missing daily reports (derived)', () => {
  const policy: DailyReportPolicy = { required: true, weekdays: [], dueLocalTime: '18:00', reporterRoles: ['FIELD'] };
  const reporter = (overrides: Partial<ExpectedReporter> = {}): ExpectedReporter => ({
    profileId: 'p1',
    memberId: 'm1',
    fullName: 'Fatma Field',
    projectRole: 'FIELD',
    startDate: '2026-09-01',
    endDate: null,
    active: true,
    ...overrides,
  });
  const base = (overrides: Partial<MissingReportInput> = {}): MissingReportInput => ({
    status: 'ACTIVE',
    projectStartDate: '2026-09-01',
    policy,
    // Sunday..Thursday
    workWeek: [7, 1, 2, 3, 4],
    timeZone: 'Africa/Cairo',
    // Thursday 2026-10-08, 14:00 in Cairo (UTC+3).
    now: new Date('2026-10-08T11:00:00.000Z'),
    reporters: [reporter()],
    submitted: new Set<string>(),
    from: '2026-10-04',
    to: '2026-10-08',
    ...overrides,
  });

  it('lists past work days as missing and today as pending before the due time', () => {
    const result = computeMissingReports(base());
    expect(result.today).toBe('2026-10-08');
    expect(result.missing.map((m) => m.date)).toEqual(['2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04']);
    expect(result.pendingToday.map((m) => m.date)).toEqual(['2026-10-08']);
  });

  it('counts today as missing once the due time has passed in the project zone', () => {
    // 18:30 in Cairo.
    const result = computeMissingReports(base({ now: new Date('2026-10-08T15:30:00.000Z') }));
    expect(result.missing.map((m) => m.date)).toContain('2026-10-08');
    expect(result.pendingToday).toHaveLength(0);
  });

  it('uses the project zone for "today" across the UTC date line', () => {
    // 2026-10-08T22:30Z is already Friday 01:30 in Cairo: Friday is not a work day and Thursday is past.
    const result = computeMissingReports(base({ now: new Date('2026-10-08T22:30:00.000Z'), to: '2026-10-09' }));
    expect(result.today).toBe('2026-10-09');
    expect(result.missing.map((m) => m.date)).toContain('2026-10-08');
    expect(result.pendingToday).toHaveLength(0);
    // The same instant in Los Angeles is still Thursday 15:30, before the due time.
    const la = computeMissingReports(
      base({ now: new Date('2026-10-08T22:30:00.000Z'), timeZone: 'America/Los_Angeles', to: '2026-10-09' }),
    );
    expect(la.today).toBe('2026-10-08');
    expect(la.pendingToday.map((m) => m.date)).toEqual(['2026-10-08']);
  });

  it('skips submitted reports, non-work days, other roles, inactive people and dates outside membership', () => {
    const result = computeMissingReports(
      base({
        submitted: new Set([submittedKey('p1', '2026-10-05')]),
        reporters: [
          reporter(),
          reporter({ profileId: 'p2', fullName: 'Dev', projectRole: 'DEVELOPER' }),
          reporter({ profileId: 'p3', fullName: 'Inactive', active: false }),
          reporter({ profileId: 'p4', fullName: 'Late joiner', startDate: '2026-10-07' }),
          reporter({ profileId: 'p5', fullName: 'Left', endDate: '2026-10-04' }),
        ],
      }),
    );
    const keys = result.missing.map((m) => `${m.reporter.profileId}:${m.date}`).sort();
    expect(keys).toEqual(['p1:2026-10-04', 'p1:2026-10-06', 'p1:2026-10-07', 'p4:2026-10-07', 'p5:2026-10-04']);
  });

  it('expects nothing when not required, not in a reporting status, or before the project start', () => {
    expect(computeMissingReports(base({ policy: { ...policy, required: false } })).missing).toHaveLength(0);
    for (const status of ['PLANNING', 'ON_HOLD', 'COMPLETED', 'ARCHIVED'] as const) {
      expect(computeMissingReports(base({ status })).missing).toHaveLength(0);
    }
    expect(computeMissingReports(base({ status: 'MAINTENANCE' })).missing.length).toBeGreaterThan(0);
    const late = computeMissingReports(base({ projectStartDate: '2026-10-07' }));
    expect(late.missing.map((m) => m.date)).toEqual(['2026-10-07']);
  });

  it('ignores dates after today', () => {
    const result = computeMissingReports(base({ to: '2026-10-20' }));
    expect(result.missing.every((m) => m.date <= '2026-10-08')).toBe(true);
  });
});

describe('project lifecycle', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('PLANNING', 'ACTIVE')).toBe(true);
    expect(canTransition('PLANNING', 'COMPLETED')).toBe(false);
    expect(canTransition('ACTIVE', 'PLANNING')).toBe(false);
    expect(canTransition('COMPLETED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'ACTIVE')).toBe(false);
    for (const target of Object.keys(STATUS_TRANSITIONS)) {
      expect(canTransition('ARCHIVED', target as keyof typeof STATUS_TRANSITIONS)).toBe(false);
    }
    for (const allowed of Object.values(STATUS_TRANSITIONS)) {
      expect(allowed).not.toContain('ARCHIVED');
    }
  });

  it('archives only non-operational projects and restores to ON_HOLD', () => {
    expect([...ARCHIVABLE_STATUSES].sort()).toEqual(['COMPLETED', 'ON_HOLD', 'PLANNING']);
    expect(RESTORED_STATUS).toBe('ON_HOLD');
  });
});

describe('PROJECT scope semantics (same everywhere)', () => {
  const row = {
    id: 'proj-1',
    members: [{ profileId: 'pf-1', projectRole: 'FIELD', profile: { memberId: 'm-field', departmentId: 'd-field' } }],
    projectManager: { memberId: 'm-pm', departmentId: 'd-eng' },
    technicalManager: null,
  } as unknown as ProjectAccessRow;

  const principal = (grants: { permissionKey: string; scope: string }[], projectIds: string[] = []): Principal => ({
    userId: 'u',
    memberId: 'm-viewer',
    organizationId: ORG,
    permissions: computeEffectivePermissions(grants),
    reach: { teamMemberIds: new Set(['m-field']), departmentIds: new Set(['d-eng']), projectIds: new Set(projectIds) },
  });

  it('derives facts from the people who staff the project', () => {
    expect(projectFacts(ORG, row)).toEqual({
      organizationId: ORG,
      projectIds: ['proj-1'],
      ownerMemberIds: ['m-field', 'm-pm'],
      subjectMemberIds: ['m-field', 'm-pm'],
      departmentIds: ['d-field', 'd-eng'],
    });
  });

  it('PROJECT scope matches only reached projects; foreign organizations never match', () => {
    const facts = projectFacts(ORG, row);
    const view = [{ permissionKey: 'project.view', scope: 'PROJECT' }];
    expect(canAccessResource(principal(view, ['proj-1']), 'project.view', facts)).toBe(true);
    expect(canAccessResource(principal(view, ['proj-2']), 'project.view', facts)).toBe(false);
    expect(canAccessResource(principal(view, []), 'project.view', facts)).toBe(false);
    expect(canAccessResource(principal(view, ['proj-1']), 'project.view', { ...facts, organizationId: 'other' })).toBe(
      false,
    );
    expect(canAccessResource(principal(view, ['proj-1']), 'project.manage', facts)).toBe(false);
  });

  it('list filters use the same reach as resource checks', () => {
    expect(
      projectScopeWhere(listScope(principal([{ permissionKey: 'project.view', scope: 'ORG' }]), 'project.view')),
    ).toBeNull();
    expect(projectScopeWhere(listScope(principal([]), 'project.view'))).toBe('none');
    expect(
      projectScopeWhere(
        listScope(principal([{ permissionKey: 'project.view', scope: 'PROJECT' }], []), 'project.view'),
      ),
    ).toBe('none');
    expect(
      projectScopeWhere(
        listScope(principal([{ permissionKey: 'project.view', scope: 'PROJECT' }], ['p1']), 'project.view'),
      ),
    ).toEqual({ OR: [{ id: { in: ['p1'] } }] });
    const department = projectScopeWhere(
      listScope(principal([{ permissionKey: 'project.view', scope: 'DEPARTMENT' }]), 'project.view'),
    );
    expect(department).toEqual({
      OR: [
        { members: { some: { profile: { departmentId: { in: ['d-eng'] } } } } },
        { projectManager: { departmentId: { in: ['d-eng'] } } },
        { technicalManager: { departmentId: { in: ['d-eng'] } } },
      ],
    });
  });

  it('daily-report facts and list filters agree', () => {
    const facts = dailyReportFacts(ORG, 'proj-1', { memberId: 'm-field', departmentId: 'd-field' });
    const viewer = principal([{ permissionKey: 'daily_report.view', scope: 'PROJECT' }], ['proj-1']);
    expect(canAccessResource(viewer, 'daily_report.view', facts)).toBe(true);
    expect(dailyReportScopeWhere(listScope(viewer, 'daily_report.view'))).toEqual({
      OR: [{ projectId: { in: ['proj-1'] } }],
    });
    const self = principal([{ permissionKey: 'daily_report.view', scope: 'SELF' }]);
    expect(canAccessResource(self, 'daily_report.view', facts)).toBe(false);
    expect(dailyReportScopeWhere(listScope(self, 'daily_report.view'))).toEqual({
      OR: [{ reporter: { memberId: { in: ['m-viewer'] } } }],
    });
    expect(dailyReportScopeWhere(listScope(principal([]), 'daily_report.view'))).toBe('none');
  });
});

describe('activity payload parsing', () => {
  const valid = {
    projectId: 'p',
    occurredAt: '2026-10-01T10:00:00.000Z',
    source: 'PROJECT',
    type: 'project.created',
    entityType: 'project',
    entityId: 'p',
    summaryParams: { code: 'PRJ-1', nested: { dropped: true } },
    actorMemberId: null,
  };

  it('accepts a well-formed payload and drops non-scalar params', () => {
    expect(parseActivityPayload(valid)?.summaryParams).toEqual({ code: 'PRJ-1' });
  });

  it.each([null, [], { ...valid, source: 'EMAIL' }, { ...valid, occurredAt: 'yesterday' }, { ...valid, projectId: 1 }])(
    'rejects malformed payloads (%j)',
    (value) => {
      expect(parseActivityPayload(value)).toBeNull();
    },
  );
});
