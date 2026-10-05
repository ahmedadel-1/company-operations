import { describe, expect, it } from 'vitest';

import {
  createWorkLocationRequestSchema,
  dailyReportPolicySchema,
  projectListQuerySchema,
  setProjectHealthRequestSchema,
  setProjectStatusRequestSchema,
  submitDailyReportRequestSchema,
  updateProjectRequestSchema,
} from '../src/index.js';

describe('project list query', () => {
  it('parses comma-separated enum filters into de-duplicated arrays', () => {
    expect(projectListQuerySchema.parse({ status: 'ACTIVE,ON_HOLD,ACTIVE', health: 'CRITICAL' })).toMatchObject({
      status: ['ACTIVE', 'ON_HOLD'],
      health: ['CRITICAL'],
    });
  });

  it.each([
    { status: 'ACTIVE,DELETED' },
    { status: '' },
    { status: 'ACTIVE,' },
    { sort: 'organizationId:asc' },
    { scope: 'everyone' },
    { orderBy: 'name' },
  ])('rejects values outside the allow-list: %o', (query) => {
    expect(projectListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('project lifecycle requests', () => {
  it('requires a version and at least one change', () => {
    expect(updateProjectRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ name: 'X' }).success).toBe(false);
    expect(updateProjectRequestSchema.safeParse({ name: 'X', version: 1 }).success).toBe(true);
  });

  it('never accepts ARCHIVED as a plain status change and always explains health', () => {
    expect(setProjectStatusRequestSchema.safeParse({ status: 'ARCHIVED', version: 1 }).success).toBe(false);
    expect(setProjectHealthRequestSchema.safeParse({ health: 'AT_RISK', version: 1 }).success).toBe(false);
    expect(setProjectHealthRequestSchema.safeParse({ health: 'AT_RISK', note: 'Why', version: 1 }).success).toBe(true);
  });

  it('validates the daily-report policy shape', () => {
    expect(
      dailyReportPolicySchema.safeParse({
        required: true,
        weekdays: [1, 7],
        dueLocalTime: '18:00',
        reporterRoles: ['FIELD'],
      }).success,
    ).toBe(true);
    expect(
      dailyReportPolicySchema.safeParse({
        required: true,
        weekdays: [8],
        dueLocalTime: '18:00',
        reporterRoles: ['FIELD'],
      }).success,
    ).toBe(false);
    expect(
      dailyReportPolicySchema.safeParse({
        required: true,
        weekdays: [],
        dueLocalTime: '24:00',
        reporterRoles: ['FIELD'],
      }).success,
    ).toBe(false);
    expect(
      dailyReportPolicySchema.safeParse({ required: true, weekdays: [], dueLocalTime: '18:00', reporterRoles: [] })
        .success,
    ).toBe(false);
  });
});

describe('work locations and daily reports', () => {
  it('bounds coordinates and radius', () => {
    const base = { name: 'Site', type: 'PROJECT_SITE', latitude: 30, longitude: 31, allowedRadiusMeters: 100 };
    expect(createWorkLocationRequestSchema.safeParse(base).success).toBe(true);
    expect(createWorkLocationRequestSchema.safeParse({ ...base, latitude: 90.1 }).success).toBe(false);
    expect(createWorkLocationRequestSchema.safeParse({ ...base, longitude: -181 }).success).toBe(false);
    expect(createWorkLocationRequestSchema.safeParse({ ...base, allowedRadiusMeters: 5 }).success).toBe(false);
  });

  it('rejects unknown fields and negative counts in a report', () => {
    const base = { systemStatus: 'NORMAL', workPerformed: 'Done.' };
    expect(submitDailyReportRequestSchema.safeParse(base).success).toBe(true);
    expect(submitDailyReportRequestSchema.safeParse({ ...base, reporterProfileId: 'x' }).success).toBe(false);
    expect(submitDailyReportRequestSchema.safeParse({ ...base, failedRequestsCount: -1 }).success).toBe(false);
    expect(submitDailyReportRequestSchema.safeParse({ ...base, reportDate: '2026-02-30' }).success).toBe(false);
  });
});
