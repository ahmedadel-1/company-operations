import { describe, expect, it } from 'vitest';

import { dayBuckets } from '../../src/modules/attendance/engine/derive.js';
import { computeEffectivePermissions } from '../../src/modules/authorization/effective-permissions.js';
import type { Principal } from '../../src/modules/authorization/policy.js';
import {
  bumpDashboardVersions,
  DashboardCache,
  InMemoryDashboardCacheStore,
} from '../../src/modules/dashboard/dashboard-cache.js';
import type { CachedRead, DashboardCacheStore } from '../../src/modules/dashboard/dashboard-cache.js';
import {
  compareAttention,
  dedupeAttention,
  prioritizeAttention,
} from '../../src/modules/dashboard/engine/attention.js';
import type { AttentionItem } from '../../src/modules/dashboard/engine/attention.js';
import { dashboardCacheKey, scopeDescriptor, versionKey } from '../../src/modules/dashboard/engine/cache-keys.js';
import { deriveChecklist } from '../../src/modules/dashboard/engine/checklist.js';
import {
  bucketDates,
  bucketInstants,
  localDayWindow,
  rangeDates,
  rangeWindow,
} from '../../src/modules/dashboard/engine/ranges.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  matchTier,
  normalizeSearchQuery,
  rankResults,
  requestNumberOf,
  ticketNumberOf,
} from '../../src/modules/dashboard/engine/search.js';
import { attendanceBucketLink, dashboardLink, supportLink } from '../../src/modules/dashboard/links.js';
import { escapeLike } from '../../src/platform/db/like.js';
import { InvalidInputError } from '../../src/platform/errors.js';

const ORG = '00000000-0000-4000-8000-0000000000aa';

const principal = (
  grants: { permissionKey: string; scope: string }[],
  memberId = 'm1',
  reach?: Principal['reach'],
): Principal => ({
  userId: `u-${memberId}`,
  memberId,
  organizationId: ORG,
  permissions: computeEffectivePermissions(grants),
  reach,
});

const item = (overrides: Partial<AttentionItem> & Pick<AttentionItem, 'key'>): AttentionItem => ({
  type: 'APPROVAL_WAITING',
  severity: 'MEDIUM',
  params: {},
  entity: { type: 'request_approval', id: overrides.key },
  occurredAt: '2026-10-01T08:00:00.000Z',
  link: { path: '/requests/x', query: {}, hash: null },
  scope: 'SELF',
  ...overrides,
});

describe('Needs Attention prioritization', () => {
  it('orders by severity, then the oldest condition, then the stable key', () => {
    const items = [
      item({ key: 'b', severity: 'MEDIUM', occurredAt: '2026-10-01T07:00:00.000Z' }),
      item({ key: 'a', severity: 'MEDIUM', occurredAt: '2026-10-01T07:00:00.000Z' }),
      item({ key: 'c', severity: 'CRITICAL', occurredAt: '2026-10-02T00:00:00.000Z' }),
      item({ key: 'd', severity: 'MEDIUM', occurredAt: '2026-09-30T00:00:00.000Z' }),
      item({ key: 'e', severity: 'HIGH' }),
      item({ key: 'f', severity: 'LOW', occurredAt: '2020-01-01T00:00:00.000Z' }),
    ];
    expect(prioritizeAttention(items).items.map((value) => value.key)).toEqual(['c', 'e', 'd', 'a', 'b', 'f']);
    // Input order never changes the result.
    expect(prioritizeAttention([...items].reverse()).items.map((value) => value.key)).toEqual([
      'c',
      'e',
      'd',
      'a',
      'b',
      'f',
    ]);
  });

  it('keeps one item per source entity: the highest severity wins', () => {
    const ticket = { type: 'support_ticket', id: 't1' };
    const result = dedupeAttention([
      item({ key: 'TICKET_SLA_AT_RISK:t1', type: 'TICKET_SLA_AT_RISK', severity: 'HIGH', entity: ticket }),
      item({ key: 'TICKET_SLA_BREACHED:t1', type: 'TICKET_SLA_BREACHED', severity: 'CRITICAL', entity: ticket }),
      item({
        key: 'TICKET_CRITICAL_UNASSIGNED:t1',
        type: 'TICKET_CRITICAL_UNASSIGNED',
        severity: 'CRITICAL',
        entity: ticket,
      }),
      item({ key: 'other', entity: { type: 'support_ticket', id: 't2' } }),
    ]);
    expect(result).toHaveLength(2);
    const winner = result.find((value) => value.entity.id === 't1');
    expect(winner?.severity).toBe('CRITICAL');
    // Equal severity and time: the stable key decides, independent of input order.
    expect(winner?.key).toBe('TICKET_CRITICAL_UNASSIGNED:t1');
  });

  it('caps the feed and reports the total before the cap', () => {
    const many = Array.from({ length: 60 }, (_, index) => item({ key: `k${String(index).padStart(2, '0')}` }));
    const result = prioritizeAttention(many);
    expect(result.items).toHaveLength(50);
    expect(result.total).toBe(60);
    expect(result.truncated).toBe(true);
    for (const entry of many.slice(0, 1)) expect(compareAttention(entry, entry)).toBe(0);
  });
});

describe('trend ranges', () => {
  it('lists local dates oldest first for each bounded range', () => {
    expect(rangeDates('today', '2026-10-04')).toEqual(['2026-10-04']);
    expect(rangeDates('7d', '2026-10-04')).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(rangeDates('30d', '2026-10-04')).toHaveLength(30);
    expect(rangeDates('90d', '2026-10-04')).toHaveLength(90);
  });

  it('uses the organization zone for "today" and the window instants', () => {
    // 22:30 UTC on 3 October is already 4 October in Riyadh (UTC+3).
    const window = rangeWindow('7d', new Date('2026-10-03T22:30:00.000Z'), 'Asia/Riyadh');
    expect(window.dates.at(-1)).toBe('2026-10-04');
    expect(window.start.toISOString()).toBe('2026-09-27T21:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-04T21:00:00.000Z');
  });

  it('keeps a DST day as one bucket (23 hours in New York in March)', () => {
    const day = localDayWindow('2026-03-08', 'America/New_York');
    expect((day.end.getTime() - day.start.getTime()) / 3_600_000).toBe(23);
  });

  it('buckets instants by local date, zero-filled, ignoring values outside the range', () => {
    const dates = ['2026-10-02', '2026-10-03', '2026-10-04'];
    const instants = [
      new Date('2026-10-02T20:59:59.000Z'), // 23:59 on 2 Oct in Riyadh
      new Date('2026-10-02T21:00:00.000Z'), // 00:00 on 3 Oct in Riyadh
      new Date('2026-10-04T10:00:00.000Z'),
      new Date('2026-09-01T10:00:00.000Z'),
    ];
    expect(bucketInstants(instants, dates, 'Asia/Riyadh')).toEqual([1, 1, 1]);
    expect(bucketDates(['2026-10-03', '2026-10-03', '2027-01-01'], dates)).toEqual([0, 2, 0]);
  });
});

describe('setup checklist', () => {
  it('derives every item from facts; Jira and GitHub are optional', () => {
    const empty = deriveChecklist({
      departments: 0,
      otherMembers: 0,
      activeWorkLocations: 0,
      attendancePolicy: false,
      publishedRequestTypes: 0,
      slaPolicies: 0,
      projects: 0,
      jiraConnected: false,
      githubConnected: false,
    });
    expect(empty.required).toBe(8);
    expect(empty.completed).toBe(1);
    expect(empty.items.filter((value) => value.optional).map((value) => value.key)).toEqual(['jira', 'github']);

    const full = deriveChecklist({
      departments: 2,
      otherMembers: 5,
      activeWorkLocations: 1,
      attendancePolicy: true,
      publishedRequestTypes: 3,
      slaPolicies: 1,
      projects: 4,
      jiraConnected: false,
      githubConnected: true,
    });
    expect(full.completed).toBe(8);
    expect(full.items.find((value) => value.key === 'departments')?.count).toBe(2);
    expect(full.items.find((value) => value.key === 'jira')?.done).toBe(false);
    expect(full.items.find((value) => value.key === 'github')?.done).toBe(true);
  });
});

describe('global search helpers', () => {
  it('normalizes with NFKC, strips control and bidi characters and collapses whitespace', () => {
    expect(normalizeSearchQuery('  ＡＢＣ\u202E  -12 ')).toBe('ABC -12');
    expect(normalizeSearchQuery('مشروع   الرياض')).toBe('مشروع الرياض');
  });

  it('enforces the length bounds after normalization', () => {
    expect(() => normalizeSearchQuery(' a ')).toThrow(InvalidInputError);
    expect(() => normalizeSearchQuery('\u200B\u200Bx')).toThrow(InvalidInputError);
    expect(() => normalizeSearchQuery('x'.repeat(101))).toThrow(InvalidInputError);
    expect(normalizeSearchQuery('x'.repeat(100))).toHaveLength(100);
  });

  it('ranks exact key, prefix, word start, then substring; ties by title then id', () => {
    expect(matchTier('sup-12', 'SUP-12', ['Printer'])).toBe(0);
    expect(matchTier('pri', null, ['Printer down'])).toBe(1);
    expect(matchTier('down', null, ['Printer down'])).toBe(2);
    expect(matchTier('nte', null, ['Printer'])).toBe(3);
    expect(matchTier('zzz', null, ['Printer'])).toBe(4);
    const ranked = rankResults('alpha', [
      { id: '3', key: null, title: 'Beta alpha', texts: [] },
      { id: '2', key: null, title: 'Alpha two', texts: [] },
      { id: '1', key: null, title: 'Alpha two', texts: [] },
      { id: '4', key: 'ALPHA', title: 'Zeta', texts: [] },
    ]);
    expect(ranked.map((value) => value.id)).toEqual(['4', '1', '2', '3']);
  });

  it('binds cursors to the normalized query and bounds the offset', () => {
    const cursor = encodeSearchCursor(5, 'printer');
    expect(decodeSearchCursor(cursor, 'printer')).toBe(5);
    expect(() => decodeSearchCursor(cursor, 'other')).toThrow(InvalidInputError);
    expect(() => decodeSearchCursor(encodeSearchCursor(50, 'printer'), 'printer')).toThrow(InvalidInputError);
    expect(() => decodeSearchCursor(encodeSearchCursor(0, 'printer'), 'printer')).toThrow(InvalidInputError);
    expect(() => decodeSearchCursor('not-base64-json', 'printer')).toThrow(InvalidInputError);
  });

  it('parses ticket and request keys', () => {
    expect(ticketNumberOf('SUP-12')).toBe(12);
    expect(ticketNumberOf('sup-7')).toBe(7);
    expect(ticketNumberOf('12')).toBe(12);
    expect(ticketNumberOf('REQ-12')).toBeNull();
    expect(requestNumberOf('REQ-7')).toBe(7);
    expect(requestNumberOf('printer')).toBeNull();
  });

  it('escapes LIKE wildcards so "%" and "_" match literally (security regression)', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    expect(escapeLike('back\\slash')).toBe('back\\\\slash');
    expect(escapeLike('plain')).toBe('plain');
  });
});

describe('dashboard cache keys', () => {
  it('starts with the tenant and never contains raw scope ids', () => {
    const key = dashboardCacheKey(ORG, 'support', 'f'.repeat(64), 'support=3');
    expect(key.startsWith(`dash:v1:${ORG}:support:`)).toBe(true);
    expect(versionKey(ORG, 'jira')).toBe(`dash:ver:${ORG}:jira`);
  });

  it('gives principals with different effective scopes different descriptors', () => {
    const orgWide = principal([{ permissionKey: 'support.view', scope: 'ORG' }], 'm1');
    const orgWideOther = principal([{ permissionKey: 'support.view', scope: 'ORG' }], 'm2');
    const projectA = principal([{ permissionKey: 'support.view', scope: 'PROJECT' }], 'm3', {
      teamMemberIds: new Set<string>(),
      departmentIds: new Set<string>(),
      projectIds: new Set(['p-a']),
    });
    const projectB = principal([{ permissionKey: 'support.view', scope: 'PROJECT' }], 'm4', {
      teamMemberIds: new Set<string>(),
      departmentIds: new Set<string>(),
      projectIds: new Set(['p-b']),
    });
    const permissions = ['support.view'] as const;
    // Identical ORG scope, not personal: the entry may be shared.
    expect(scopeDescriptor(orgWide, permissions, false)).toBe(scopeDescriptor(orgWideOther, permissions, false));
    // Personal results are never shared between members.
    expect(scopeDescriptor(orgWide, permissions, true)).not.toBe(scopeDescriptor(orgWideOther, permissions, true));
    // A narrower principal never maps to a broader principal's entry.
    expect(scopeDescriptor(projectA, permissions, false)).not.toBe(scopeDescriptor(orgWide, permissions, false));
    expect(scopeDescriptor(projectA, permissions, false)).not.toBe(scopeDescriptor(projectB, permissions, false));
  });
});

const read = (overrides: Partial<CachedRead> = {}): CachedRead => ({
  dashboard: 'support',
  principal: principal([{ permissionKey: 'support.view', scope: 'ORG' }]),
  permissions: ['support.view'],
  personal: false,
  domains: ['support'],
  ...overrides,
});

describe('dashboard cache', () => {
  it('serves a hit until the domain version is bumped', async () => {
    const store = new InMemoryDashboardCacheStore();
    const cache = new DashboardCache(store);
    let computed = 0;
    const compute = () => {
      computed += 1;
      return Promise.resolve({ value: computed });
    };
    expect(await cache.getOrCompute(read(), compute)).toEqual({ value: 1 });
    expect(await cache.getOrCompute(read(), compute)).toEqual({ value: 1 });
    await bumpDashboardVersions(store, ORG, ['projects']);
    expect(await cache.getOrCompute(read(), compute)).toEqual({ value: 1 });
    await bumpDashboardVersions(store, ORG, ['support']);
    expect(await cache.getOrCompute(read(), compute)).toEqual({ value: 2 });
  });

  it('expires entries after the TTL', async () => {
    let now = 0;
    const store = new InMemoryDashboardCacheStore(() => now);
    const cache = new DashboardCache(store, () => undefined, 60);
    let computed = 0;
    const compute = () => Promise.resolve(++computed);
    await cache.getOrCompute(read(), compute);
    now = 59_000;
    expect(await cache.getOrCompute(read(), compute)).toBe(1);
    now = 60_000;
    expect(await cache.getOrCompute(read(), compute)).toBe(2);
  });

  it('isolates tenants and scopes', async () => {
    const store = new InMemoryDashboardCacheStore();
    const cache = new DashboardCache(store);
    await cache.getOrCompute(read(), () => Promise.resolve('org-wide'));
    const narrow = principal([{ permissionKey: 'support.view', scope: 'PROJECT' }], 'm9', {
      teamMemberIds: new Set<string>(),
      departmentIds: new Set<string>(),
      projectIds: new Set(['p-1']),
    });
    expect(await cache.getOrCompute(read({ principal: narrow }), () => Promise.resolve('narrow'))).toBe('narrow');
    const otherTenant: Principal = {
      ...principal([{ permissionKey: 'support.view', scope: 'ORG' }]),
      organizationId: 'org-b',
    };
    expect(await cache.getOrCompute(read({ principal: otherTenant }), () => Promise.resolve('tenant-b'))).toBe(
      'tenant-b',
    );
    for (const key of store.entries.keys()) {
      expect(key.includes('p-1')).toBe(false);
      expect(key.includes('m9')).toBe(false);
    }
  });

  it('falls back to the source when Redis fails or is slow, and reports it', async () => {
    const failing: DashboardCacheStore = {
      get: () => Promise.reject(new Error('down')),
      mget: () => Promise.reject(new Error('down')),
      setWithTtl: () => Promise.reject(new Error('down')),
      increment: () => Promise.reject(new Error('down')),
    };
    const errors: string[] = [];
    const cache = new DashboardCache(failing, (operation) => {
      errors.push(operation);
    });
    expect(await cache.getOrCompute(read(), () => Promise.resolve('fresh'))).toBe('fresh');
    expect(errors).toEqual(['versions']);

    const hanging: DashboardCacheStore = {
      get: () => new Promise<string | null>(() => undefined),
      mget: () => Promise.resolve([null]),
      setWithTtl: () => new Promise<void>(() => undefined),
      increment: () => Promise.resolve(),
    };
    const slowErrors: string[] = [];
    const slow = new DashboardCache(hanging, (operation) => slowErrors.push(operation), 60, 20);
    expect(await slow.getOrCompute(read(), () => Promise.resolve('fresh'))).toBe('fresh');
    expect(slowErrors).toEqual(['get', 'set']);

    const bumpErrors: string[] = [];
    await bumpDashboardVersions(failing, ORG, ['support', 'support', 'jira'], (operation) =>
      bumpErrors.push(operation),
    );
    expect(bumpErrors).toEqual(['bump', 'bump']);
  });

  it('computes directly without a store', async () => {
    const cache = new DashboardCache(null);
    expect(await cache.getOrCompute(read(), () => Promise.resolve(7))).toBe(7);
  });
});

describe('dashboard links', () => {
  it('drops empty values, joins lists and always names the ticket view', () => {
    expect(dashboardLink('/x', { a: undefined, b: '', c: ['A', 'B'] }, null)).toEqual({
      path: '/x',
      query: { c: 'A,B' },
      hash: null,
    });
    expect(supportLink({ status: ['NEW'] }).query).toEqual({ view: 'all', status: 'NEW' });
    expect(supportLink({ view: 'open', slaState: ['AT_RISK'] }).query).toEqual({ view: 'open', slaState: 'AT_RISK' });
    expect(attendanceBucketLink('2026-10-04', 'LATE')).toEqual({
      path: '/attendance/team',
      query: { date: '2026-10-04', bucket: 'LATE' },
      hash: 'day',
    });
  });
});

describe('attendance day buckets', () => {
  it('counts present, remote, late and missing check-out as overlapping buckets', () => {
    expect(dayBuckets('COMPLETE', { mode: 'REMOTE', lateMinutes: 5 })).toEqual(['PRESENT', 'REMOTE', 'LATE']);
    expect(dayBuckets('MISSING_CHECKOUT', { mode: 'OFFICE', lateMinutes: 0 })).toEqual(['PRESENT', 'MISSING_CHECKOUT']);
    expect(dayBuckets('CHECKED_IN', null)).toEqual(['PRESENT']);
    expect(dayBuckets('ON_LEAVE', null)).toEqual(['ON_LEAVE']);
    expect(dayBuckets('ON_MISSION', null)).toEqual(['ON_MISSION']);
    expect(dayBuckets('NOT_STARTED', null)).toEqual(['NOT_CHECKED_IN']);
    expect(dayBuckets('ABSENT', null)).toEqual(['NOT_CHECKED_IN']);
    expect(dayBuckets('OFF_DAY', null)).toEqual([]);
    expect(dayBuckets('UPCOMING', null)).toEqual([]);
  });
});
