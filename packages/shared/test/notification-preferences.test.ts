import { describe, expect, it } from 'vitest';

import {
  isLockedPreference,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PREFERENCE_CHANNELS,
  notificationCategory,
  preferenceAllows,
} from '../src/notification-preferences.js';

describe('notificationCategory', () => {
  it.each([
    ['SUPPORT_TICKET_ASSIGNED', 'SUPPORT'],
    ['SUPPORT_SLA_BREACHED', 'SUPPORT'],
    ['REQUEST_APPROVAL_OVERDUE', 'REQUESTS'],
    ['ATTENDANCE_MISSING_CHECKOUT', 'ATTENDANCE'],
    ['DAILY_REPORT_MISSING', 'DAILY_REPORTS'],
    ['DAILY_REPORTS_MISSING_SUMMARY', 'DAILY_REPORTS'],
    ['PROJECT_MEMBER_ADDED', 'PROJECTS'],
    ['JIRA_REAUTH_REQUIRED', 'INTEGRATIONS'],
    ['GITHUB_INSTALLATION_SUSPENDED', 'INTEGRATIONS'],
    ['TENDER_DEADLINE_APPROACHING', 'COMMERCIAL'],
    ['CONTRACT_OBLIGATION_OVERDUE', 'COMMERCIAL'],
    ['CORPORATE_DOCUMENT_EXPIRED', 'COMMERCIAL'],
    ['GUARANTEE_EXPIRED', 'COMMERCIAL'],
    ['ROLE_GRANTED', 'ACCESS'],
    ['INVITATION_ACCEPTED', 'ACCESS'],
  ] as const)('%s → %s', (type, category) => {
    expect(notificationCategory(type)).toBe(category);
  });

  it('puts unknown types in the non-mutable ACCESS category', () => {
    expect(notificationCategory('SOMETHING_NEW')).toBe('ACCESS');
    expect(isLockedPreference('ACCESS', 'IN_APP')).toBe(true);
    expect(isLockedPreference('ACCESS', 'EMAIL')).toBe(true);
  });
});

describe('isLockedPreference', () => {
  it('locks security on both channels and integration alerts in-app only', () => {
    const locked = NOTIFICATION_CATEGORIES.flatMap((category) =>
      NOTIFICATION_PREFERENCE_CHANNELS.filter((channel) => isLockedPreference(category, channel)).map(
        (channel) => `${category}:${channel}`,
      ),
    );
    expect(locked).toEqual(['ACCESS:IN_APP', 'ACCESS:EMAIL', 'INTEGRATIONS:IN_APP']);
  });
});

describe('preferenceAllows', () => {
  const allOff = () => false;
  const allOn = () => true;

  it('follows the stored choice for mutable categories', () => {
    expect(preferenceAllows(allOff, 'SUPPORT_TICKET_COMMENTED', 'INFO', 'IN_APP')).toBe(false);
    expect(preferenceAllows(allOff, 'SUPPORT_TICKET_COMMENTED', 'INFO', 'EMAIL')).toBe(false);
    expect(preferenceAllows(allOn, 'SUPPORT_TICKET_COMMENTED', 'INFO', 'EMAIL')).toBe(true);
    expect(preferenceAllows(allOff, 'JIRA_REAUTH_REQUIRED', 'WARNING', 'EMAIL')).toBe(false);
  });

  it('always delivers CRITICAL severity and locked categories', () => {
    expect(preferenceAllows(allOff, 'SUPPORT_SLA_BREACHED', 'CRITICAL', 'IN_APP')).toBe(true);
    expect(preferenceAllows(allOff, 'SUPPORT_SLA_BREACHED', 'CRITICAL', 'EMAIL')).toBe(true);
    expect(preferenceAllows(allOff, 'ROLE_GRANTED', 'INFO', 'EMAIL')).toBe(true);
    expect(preferenceAllows(allOff, 'JIRA_REAUTH_REQUIRED', 'WARNING', 'IN_APP')).toBe(true);
  });

  it('reads the lookup per category and channel', () => {
    const lookup = (category: string, channel: string) => !(category === 'REQUESTS' && channel === 'EMAIL');
    expect(preferenceAllows(lookup, 'REQUEST_APPROVED', 'INFO', 'EMAIL')).toBe(false);
    expect(preferenceAllows(lookup, 'REQUEST_APPROVED', 'INFO', 'IN_APP')).toBe(true);
    expect(preferenceAllows(lookup, 'SUPPORT_TICKET_RESOLVED', 'INFO', 'EMAIL')).toBe(true);
  });
});
