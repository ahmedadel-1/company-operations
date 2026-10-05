import { describe, expect, it } from 'vitest';

import { Prisma } from '@company-ops/db';

import {
  amendmentKey,
  baselineEditable,
  checkContractTransition,
  contractKey,
  statusAfterRenewalAction,
} from '../../src/modules/commercial/engine/contract-state.js';
import {
  deadlineReminderThreshold,
  documentValidity,
  dueReminderThreshold,
  guaranteeStatus,
  noticeDeadline,
  validOn,
} from '../../src/modules/commercial/engine/dates.js';
import { evaluateHealth } from '../../src/modules/commercial/engine/health.js';
import type { HealthFacts } from '../../src/modules/commercial/engine/health.js';
import { formatAmount, toMoney, totalsByCurrency } from '../../src/modules/commercial/engine/money.js';
import { projectContract } from '../../src/modules/commercial/engine/projection.js';
import {
  isRequirementOverdue,
  readinessCounters,
  readinessPercent,
  readinessState,
  readinessView,
  requirementTransitionAllowed,
} from '../../src/modules/commercial/engine/readiness.js';
import type { RequirementActor, RequirementFacts } from '../../src/modules/commercial/engine/readiness.js';
import {
  MAX_OCCURRENCES_PER_PASS,
  nthDueDate,
  planOccurrences,
} from '../../src/modules/commercial/engine/recurrence.js';
import {
  checkManualTransition,
  statusAfterBidDecision,
  tenderKey,
} from '../../src/modules/commercial/engine/tender-state.js';
import { renderNotificationEmail } from '../../src/modules/notifications/email-templates.js';
import { csvCell, toCsv } from '../../src/platform/csv.js';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
const requirement = (overrides: Partial<RequirementFacts>): RequirementFacts => ({
  status: 'NOT_STARTED',
  mandatory: true,
  ownerMemberId: 'owner',
  dueDate: null,
  ...overrides,
});

describe('tender readiness (one formula)', () => {
  it('excludes NOT_APPLICABLE from every denominator and keeps optional requirements out of the state', () => {
    const counters = readinessCounters([
      requirement({ status: 'APPROVED' }),
      requirement({ status: 'APPROVED' }),
      requirement({ status: 'IN_PROGRESS' }),
      requirement({ status: 'NOT_APPLICABLE' }),
      requirement({ status: 'NOT_STARTED', mandatory: false }),
      requirement({ status: 'BLOCKED', ownerMemberId: null }),
    ]);
    expect(counters).toMatchObject({
      requirementsTotal: 6,
      mandatoryApplicable: 4,
      mandatoryApproved: 2,
      optionalApplicable: 1,
      optionalApproved: 0,
      blockedRequirements: 1,
      unassignedRequirements: 1,
    });
    expect(readinessPercent(counters)).toBe(50);
    expect(readinessState(counters)).toBe('NOT_READY');
  });

  it('is NO_MANDATORY with a null percentage instead of a misleading 100%', () => {
    const counters = readinessCounters([
      requirement({ mandatory: false, status: 'APPROVED' }),
      requirement({ status: 'NOT_APPLICABLE' }),
    ]);
    expect(readinessState(counters)).toBe('NO_MANDATORY');
    expect(readinessPercent(counters)).toBeNull();
    expect(readinessView(counters, null)).toMatchObject({
      state: 'NO_MANDATORY',
      percent: null,
      inProgress: null,
      overdue: null,
    });
  });

  it('rounds down and reaches READY only when every applicable mandatory requirement is approved', () => {
    expect(readinessPercent({ mandatoryApplicable: 3, mandatoryApproved: 2 })).toBe(66);
    expect(readinessState({ mandatoryApplicable: 3, mandatoryApproved: 3 })).toBe('READY');
  });

  it('counts overdue in the organization date and never for approved or not applicable requirements', () => {
    expect(isRequirementOverdue({ status: 'IN_PROGRESS', dueDate: '2026-10-04' }, '2026-10-05')).toBe(true);
    expect(isRequirementOverdue({ status: 'IN_PROGRESS', dueDate: '2026-10-05' }, '2026-10-05')).toBe(false);
    expect(isRequirementOverdue({ status: 'APPROVED', dueDate: '2026-01-01' }, '2026-10-05')).toBe(false);
    expect(isRequirementOverdue({ status: 'NOT_APPLICABLE', dueDate: '2026-01-01' }, '2026-10-05')).toBe(false);
    const view = readinessView(readinessCounters([requirement({ dueDate: '2026-10-01', status: 'IN_PROGRESS' })]), {
      requirements: [requirement({ dueDate: '2026-10-01', status: 'IN_PROGRESS' })],
      today: '2026-10-05',
    });
    expect(view).toMatchObject({ inProgress: 1, overdue: 1, mandatoryMissing: 1 });
  });

  it('separates owner work, reviewer decisions and manager scoping', () => {
    const owner = new Set<RequirementActor>(['OWNER']);
    const reviewer = new Set<RequirementActor>(['REVIEWER']);
    const manager = new Set<RequirementActor>(['MANAGER']);
    expect(requirementTransitionAllowed('NOT_STARTED', 'IN_PROGRESS', owner)).toBe(true);
    expect(requirementTransitionAllowed('IN_PROGRESS', 'READY_FOR_REVIEW', owner)).toBe(true);
    expect(requirementTransitionAllowed('READY_FOR_REVIEW', 'APPROVED', owner)).toBe(false);
    expect(requirementTransitionAllowed('READY_FOR_REVIEW', 'APPROVED', reviewer)).toBe(true);
    expect(requirementTransitionAllowed('IN_PROGRESS', 'APPROVED', reviewer)).toBe(false);
    expect(requirementTransitionAllowed('IN_PROGRESS', 'NOT_APPLICABLE', owner)).toBe(false);
    expect(requirementTransitionAllowed('IN_PROGRESS', 'NOT_APPLICABLE', manager)).toBe(true);
    expect(requirementTransitionAllowed('APPROVED', 'IN_PROGRESS', owner)).toBe(false);
    expect(requirementTransitionAllowed('APPROVED', 'IN_PROGRESS', manager)).toBe(true);
    expect(requirementTransitionAllowed('READY_FOR_REVIEW', 'IN_PROGRESS', reviewer)).toBe(false);
  });
});

describe('tender lifecycle', () => {
  it('allows manual transitions and keeps controlled targets behind their own operations', () => {
    expect(checkManualTransition('DRAFT', 'NEW')).toMatchObject({
      ok: true,
      permission: 'tender.edit',
      needsReason: false,
    });
    expect(checkManualTransition('NEW', 'CANCELLED')).toMatchObject({ ok: true, needsReason: true });
    expect(checkManualTransition('BID_DECISION_PENDING', 'PREPARING')).toEqual({ ok: false, reason: 'CONTROLLED' });
    expect(checkManualTransition('READY_FOR_SUBMISSION', 'SUBMITTED')).toEqual({ ok: false, reason: 'CONTROLLED' });
    expect(checkManualTransition('SUBMITTED', 'AWARDED')).toEqual({ ok: false, reason: 'CONTROLLED' });
    expect(checkManualTransition('DRAFT', 'SUBMITTED')).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
    expect(checkManualTransition('ARCHIVED', 'NEW')).toEqual({ ok: false, reason: 'NOT_ALLOWED' });
    expect(statusAfterBidDecision('BID')).toBe('PREPARING');
    expect(statusAfterBidDecision('NO_BID')).toBe('NO_BID');
  });

  it('formats keys with an organization-wide number', () => {
    expect(tenderKey(2026, 7)).toBe('TND-2026-0007');
    expect(contractKey(2027, 12345)).toBe('CTR-2027-12345');
    expect(amendmentKey(2026, 3, 2)).toBe('CTR-2026-0003-A02');
  });
});

describe('contract lifecycle and projection', () => {
  it('needs contract.approve to approve and activate, and reasons for disruptive moves', () => {
    expect(checkContractTransition('DRAFT', 'UNDER_REVIEW')).toEqual({
      ok: true,
      permission: 'contract.edit',
      needsReason: false,
    });
    expect(checkContractTransition('UNDER_REVIEW', 'AWAITING_SIGNATURE')).toMatchObject({
      permission: 'contract.approve',
    });
    expect(checkContractTransition('AWAITING_SIGNATURE', 'ACTIVE')).toMatchObject({ permission: 'contract.approve' });
    expect(checkContractTransition('ACTIVE', 'TERMINATED')).toMatchObject({ needsReason: true });
    expect(checkContractTransition('EXPIRED', 'CLOSED')).toMatchObject({ needsReason: false });
    expect(checkContractTransition('DRAFT', 'ACTIVE')).toEqual({ ok: false });
    expect(checkContractTransition('CLOSED', 'ACTIVE')).toEqual({ ok: false });
    expect(baselineEditable('DRAFT')).toBe(true);
    expect(baselineEditable('ACTIVE')).toBe(false);
  });

  it('starts a new term only with a future expiry and never reopens closed states', () => {
    expect(statusAfterRenewalAction('ACTIVE', 'REVIEW_STARTED', null, '2026-10-05')).toBe('RENEWAL_REVIEW');
    expect(statusAfterRenewalAction('EXPIRED', 'RENEWED', '2027-10-05', '2026-10-05')).toBe('ACTIVE');
    expect(statusAfterRenewalAction('EXPIRED', 'RENEWED', '2026-10-01', '2026-10-05')).toBe('EXPIRED');
    expect(statusAfterRenewalAction('ACTIVE', 'RENEW', null, '2026-10-05')).toBe('ACTIVE');
  });

  it('rebuilds current value and expiry from the immutable baseline in application order', () => {
    const projection = projectContract({
      originalValue: d('1000000.0000'),
      originalExpiryDate: '2027-12-31',
      noticePeriodDays: 90,
      amendments: [
        { valueDelta: d('250000.50'), newExpiryDate: null, appliedAt: new Date('2027-01-10T00:00:00Z') },
        { valueDelta: d('-50000'), newExpiryDate: '2028-06-30', appliedAt: new Date('2027-03-01T00:00:00Z') },
      ],
      renewals: [{ newExpiryDate: '2028-12-31', appliedAt: new Date('2027-02-01T00:00:00Z') }],
    });
    expect(formatAmount(projection.currentValue)).toBe('1200000.5');
    expect(projection.currentExpiryDate).toBe('2028-06-30');
    expect(projection.renewalNoticeDeadline).toBe('2028-04-01');
    const untouched = projectContract({
      originalValue: d('10'),
      originalExpiryDate: null,
      noticePeriodDays: 30,
      amendments: [],
      renewals: [],
    });
    expect(formatAmount(untouched.currentValue)).toBe('10');
    expect(untouched.renewalNoticeDeadline).toBeNull();
  });

  it('computes the notice deadline in calendar days', () => {
    expect(noticeDeadline('2027-12-31', 90)).toBe('2027-10-02');
    expect(noticeDeadline('2028-03-01', 1)).toBe('2028-02-29');
    expect(noticeDeadline(null, 30)).toBeNull();
    expect(noticeDeadline('2027-12-31', null)).toBeNull();
  });
});

describe('contract health (deterministic, explainable)', () => {
  const healthy: HealthFacts = {
    status: 'ACTIVE',
    renewalType: 'MANUAL_RENEWAL',
    currentExpiryDate: '2028-12-31',
    renewalDecisionDate: null,
    renewalNoticeDeadline: '2028-10-02',
    renewalDecided: false,
    overdueObligations: 0,
    overdueCriticalObligations: 0,
    overdueMilestones: 0,
    expiringGuarantees: 0,
    expiredGuarantees: 0,
    hasSignedContract: true,
    amendmentsUnderReview: 0,
  };

  it('is HEALTHY without reasons and takes the most severe reason otherwise', () => {
    expect(evaluateHealth(healthy, '2026-10-05')).toEqual({ health: 'HEALTHY', reasons: [] });
    expect(evaluateHealth({ ...healthy, overdueObligations: 2 }, '2026-10-05')).toEqual({
      health: 'NEEDS_ATTENTION',
      reasons: ['OBLIGATION_OVERDUE'],
    });
    expect(evaluateHealth({ ...healthy, overdueObligations: 1, overdueCriticalObligations: 1 }, '2026-10-05')).toEqual({
      health: 'CRITICAL',
      reasons: ['CRITICAL_OBLIGATION_OVERDUE'],
    });
    expect(evaluateHealth({ ...healthy, overdueMilestones: 1, expiringGuarantees: 1 }, '2026-10-05')).toMatchObject({
      health: 'AT_RISK',
      reasons: ['MILESTONE_OVERDUE', 'GUARANTEE_EXPIRING'],
    });
  });

  it('flags expiry, notice and decision dates relative to the organization date', () => {
    const near = { ...healthy, currentExpiryDate: '2026-12-01', renewalNoticeDeadline: '2026-10-20' };
    expect(evaluateHealth(near, '2026-10-05').reasons).toEqual(['EXPIRY_APPROACHING', 'NOTICE_DEADLINE_APPROACHING']);
    expect(evaluateHealth({ ...near, renewalNoticeDeadline: '2026-10-01' }, '2026-10-05')).toMatchObject({
      health: 'CRITICAL',
      reasons: ['EXPIRY_APPROACHING', 'NOTICE_DEADLINE_PASSED'],
    });
    expect(evaluateHealth({ ...near, renewalDecided: true }, '2026-10-05').reasons).toEqual(['EXPIRY_APPROACHING']);
    expect(evaluateHealth({ ...healthy, status: 'EXPIRED', currentExpiryDate: '2026-09-01' }, '2026-10-05')).toEqual({
      health: 'CRITICAL',
      reasons: ['EXPIRED_WITHOUT_DECISION'],
    });
    expect(
      evaluateHealth({ ...healthy, renewalType: 'EVERGREEN', currentExpiryDate: '2026-11-01' }, '2026-10-05').reasons,
    ).toEqual([]);
  });

  it('does not evaluate contracts that are not monitored', () => {
    expect(
      evaluateHealth({ ...healthy, status: 'DRAFT', hasSignedContract: false, overdueObligations: 3 }, '2026-10-05'),
    ).toEqual({
      health: 'HEALTHY',
      reasons: [],
    });
  });
});

describe('obligation recurrence (bounded, month-end safe)', () => {
  it('clamps to the month end and keeps the anchor day afterwards', () => {
    expect(nthDueDate('2027-01-31', 'MONTHLY', 1)).toBe('2027-02-28');
    expect(nthDueDate('2027-01-31', 'MONTHLY', 2)).toBe('2027-03-31');
    expect(nthDueDate('2028-01-31', 'MONTHLY', 1)).toBe('2028-02-29');
    expect(nthDueDate('2028-02-29', 'YEARLY', 1)).toBe('2029-02-28');
    expect(nthDueDate('2026-11-30', 'QUARTERLY', 1)).toBe('2027-02-28');
    expect(nthDueDate('2026-10-05', 'NONE', 5)).toBe('2026-10-05');
  });

  it('plans up to the horizon or the series end and skips what was generated before', () => {
    const first = planOccurrences({
      anchor: '2026-10-10',
      recurrence: 'MONTHLY',
      until: null,
      today: '2026-10-05',
      after: null,
    });
    expect(first.dueDates).toEqual(['2026-10-10', '2026-11-10', '2026-12-10']);
    expect(first.generatedThrough).toBe('2027-01-08');
    const next = planOccurrences({
      anchor: '2026-10-10',
      recurrence: 'MONTHLY',
      until: null,
      today: '2026-11-15',
      after: first.generatedThrough,
    });
    expect(next.dueDates).toEqual(['2027-01-10', '2027-02-10']);
    const capped = planOccurrences({
      anchor: '2026-10-10',
      recurrence: 'MONTHLY',
      until: '2026-11-30',
      today: '2026-10-05',
      after: null,
    });
    expect(capped).toEqual({ dueDates: ['2026-10-10', '2026-11-10'], generatedThrough: '2026-11-30' });
    expect(
      planOccurrences({ anchor: '2026-10-10', recurrence: 'NONE', until: null, today: '2026-10-05', after: null })
        .dueDates,
    ).toEqual(['2026-10-10']);
    expect(
      planOccurrences({
        anchor: '2026-10-10',
        recurrence: 'NONE',
        until: null,
        today: '2026-10-05',
        after: '2026-10-10',
      }).dueDates,
    ).toEqual([]);
  });

  it('bounds one pass even for an old anchor', () => {
    const plan = planOccurrences({
      anchor: '2020-01-01',
      recurrence: 'MONTHLY',
      until: null,
      today: '2026-10-05',
      after: null,
    });
    expect(plan.dueDates).toHaveLength(MAX_OCCURRENCES_PER_PASS);
    expect(plan.generatedThrough).toBe(plan.dueDates.at(-1));
  });
});

describe('commercial dates and reminders', () => {
  it('derives document validity and guarantee status from the organization date', () => {
    expect(documentValidity(0, null, '2026-10-05')).toBe('NO_VERSION');
    expect(documentValidity(1, null, '2026-10-05')).toBe('NO_EXPIRY');
    expect(documentValidity(1, '2026-10-04', '2026-10-05')).toBe('EXPIRED');
    expect(documentValidity(1, '2026-11-04', '2026-10-05')).toBe('EXPIRING');
    expect(documentValidity(1, '2026-11-05', '2026-10-05')).toBe('VALID');
    expect(guaranteeStatus('ACTIVE', '2026-10-04', '2026-10-05')).toBe('EXPIRED');
    expect(guaranteeStatus('ACTIVE', '2026-10-20', '2026-10-05')).toBe('EXPIRING');
    expect(guaranteeStatus('ACTIVE', '2027-01-01', '2026-10-05')).toBe('ACTIVE');
    expect(guaranteeStatus('RELEASED', '2026-10-04', '2026-10-05')).toBe('RELEASED');
  });

  it('checks version validity on a tender deadline date', () => {
    expect(validOn({ validFrom: null, expiryDate: '2026-12-31' }, '2026-12-31')).toBe(true);
    expect(validOn({ validFrom: null, expiryDate: '2026-12-30' }, '2026-12-31')).toBe(false);
    expect(validOn({ validFrom: '2027-01-01', expiryDate: '2027-12-31' }, '2026-12-31')).toBe(false);
    expect(validOn({ validFrom: null, expiryDate: null }, '2026-12-31')).toBeNull();
    expect(validOn({ validFrom: null, expiryDate: '2026-12-31' }, null)).toBeNull();
  });

  it('sends the smallest due threshold from 09:00 local time and nothing after the date', () => {
    const zone = 'Africa/Cairo';
    // Cairo observes UTC+3 until late October 2026, so 09:00 local is 06:00 UTC.
    expect(dueReminderThreshold('2026-10-12', [30, 7, 1], new Date('2026-10-05T05:59:00Z'), zone)).toBe(30);
    expect(dueReminderThreshold('2026-10-12', [7, 1], new Date('2026-10-05T05:59:00Z'), zone)).toBeNull();
    expect(dueReminderThreshold('2026-10-12', [30, 7, 1], new Date('2026-10-05T06:00:00Z'), zone)).toBe(7);
    expect(dueReminderThreshold('2026-10-12', [30, 7, 1], new Date('2026-10-11T07:00:00Z'), zone)).toBe(1);
    expect(dueReminderThreshold('2026-10-12', [30, 7, 1], new Date('2026-10-13T07:00:00Z'), zone)).toBeNull();
    const deadline = new Date('2026-10-20T12:00:00Z');
    expect(deadlineReminderThreshold(deadline, [14, 7, 3, 1], new Date('2026-10-01T12:00:00Z'))).toBeNull();
    expect(deadlineReminderThreshold(deadline, [14, 7, 3, 1], new Date('2026-10-14T12:00:00Z'))).toBe(7);
    expect(deadlineReminderThreshold(deadline, [14, 7, 3, 1], new Date('2026-10-20T12:00:00Z'))).toBeNull();
  });
});

describe('money, CSV and commercial email', () => {
  it('formats decimal strings without floating point and never mixes currencies', () => {
    expect(formatAmount(d('1200.5000'))).toBe('1200.5');
    expect(formatAmount(d('0'))).toBe('0');
    expect(formatAmount(d('0.1').plus(d('0.2')))).toBe('0.3');
    expect(toMoney(null, 'EGP')).toBeUndefined();
    expect(
      totalsByCurrency([
        { amount: d('10.25'), currency: 'USD' },
        { amount: d('5'), currency: 'EGP' },
        { amount: d('0.75'), currency: 'USD' },
      ]),
    ).toEqual([
      { currency: 'EGP', amount: '5' },
      { currency: 'USD', amount: '11' },
    ]);
  });

  it('escapes spreadsheet formulas and quotes separators', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['k', 'v'], [['a', 1]])).toBe('k,v\r\na,1\r\n');
  });

  it('renders commercial emails in both languages without amounts and escapes user text', () => {
    for (const language of ['en', 'ar'] as const) {
      const email = renderNotificationEmail({
        type: 'CONTRACT_EXPIRY_APPROACHING',
        params: { contractKey: 'CTR-2026-0001', contractTitle: '<b>Support</b>', date: '2026-12-31', days: '30' },
        language,
        link: 'https://ops.example.test/contracts/1',
      });
      expect(email.subject).toContain('CTR-2026-0001');
      expect(email.html).not.toContain('<b>Support</b>');
      expect(email.html).toContain(language === 'ar' ? 'dir="rtl"' : 'dir="ltr"');
    }
    const guarantee = renderNotificationEmail({
      type: 'GUARANTEE_EXPIRED',
      params: {
        parentKey: 'CTR-2026-0001',
        guaranteeType: 'PERFORMANCE_GUARANTEE',
        expiryDate: '2026-10-01',
        days: '0',
      },
      language: 'en',
      link: 'https://ops.example.test/contracts/1',
    });
    expect(guarantee.text).toContain('CTR-2026-0001');
  });
});
