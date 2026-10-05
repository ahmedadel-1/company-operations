/**
 * Notification preference rules (ADR-0023). Categories are derived from the stable notification type,
 * so a new type lands in a category without a migration. Channels are in-app and email only.
 */
export const NOTIFICATION_CATEGORIES = [
  'ACCESS',
  'PROJECTS',
  'DAILY_REPORTS',
  'SUPPORT',
  'REQUESTS',
  'ATTENDANCE',
  'INTEGRATIONS',
  'COMMERCIAL',
] as const;
export type NotificationCategoryKey = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_PREFERENCE_CHANNELS = ['IN_APP', 'EMAIL'] as const;
export type NotificationPreferenceChannelKey = (typeof NOTIFICATION_PREFERENCE_CHANNELS)[number];

export type NotificationSeverityKey = 'INFO' | 'WARNING' | 'CRITICAL';

const PREFIXES: readonly (readonly [string, NotificationCategoryKey])[] = [
  ['DAILY_REPORT', 'DAILY_REPORTS'],
  ['PROJECT_', 'PROJECTS'],
  ['SUPPORT_', 'SUPPORT'],
  ['REQUEST_', 'REQUESTS'],
  ['ATTENDANCE_', 'ATTENDANCE'],
  ['JIRA_', 'INTEGRATIONS'],
  ['GITHUB_', 'INTEGRATIONS'],
  ['TENDER_', 'COMMERCIAL'],
  ['CONTRACT_', 'COMMERCIAL'],
  ['CORPORATE_DOCUMENT_', 'COMMERCIAL'],
  ['GUARANTEE_', 'COMMERCIAL'],
];

/**
 * The category of a notification type. Unknown types fall into ACCESS, which cannot be muted: a type
 * nobody classified is never silently suppressed.
 */
export function notificationCategory(type: string): NotificationCategoryKey {
  for (const [prefix, category] of PREFIXES) {
    if (type.startsWith(prefix)) {
      return category;
    }
  }
  return 'ACCESS';
}

/** Security notifications on every channel and integration alerts in-app cannot be turned off. */
export function isLockedPreference(
  category: NotificationCategoryKey,
  channel: NotificationPreferenceChannelKey,
): boolean {
  return category === 'ACCESS' || (category === 'INTEGRATIONS' && channel === 'IN_APP');
}

/** Stored opt-outs of one member: `${category}:${channel}` → enabled. Missing = enabled. */
export type PreferenceLookup = (
  category: NotificationCategoryKey,
  channel: NotificationPreferenceChannelKey,
) => boolean;

/**
 * Whether a notification is delivered on a channel. CRITICAL severity and locked categories always
 * are; otherwise the member's stored choice applies (default on).
 */
export function preferenceAllows(
  enabled: PreferenceLookup,
  type: string,
  severity: NotificationSeverityKey,
  channel: NotificationPreferenceChannelKey,
): boolean {
  const category = notificationCategory(type);
  if (severity === 'CRITICAL' || isLockedPreference(category, channel)) {
    return true;
  }
  return enabled(category, channel);
}
