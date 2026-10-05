export { evaluateCondition, evaluateRule } from './conditions.js';
export type {
  ConditionInput,
  ConditionOperator,
  ConditionRuleInput,
  FieldValue,
  NormalizedData,
} from './conditions.js';
export { defaultErrorCodeForStatus, ERROR_CODES } from './errors.js';
export type { ErrorCode } from './errors.js';
export { LOG_REDACT_PATHS, pinoSecurityOptions, REDACTED, redactSecrets, serializeErrorForLog } from './logging.js';
export {
  isLockedPreference,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_PREFERENCE_CHANNELS,
  notificationCategory,
  preferenceAllows,
} from './notification-preferences.js';
export type {
  NotificationCategoryKey,
  NotificationPreferenceChannelKey,
  NotificationSeverityKey,
  PreferenceLookup,
} from './notification-preferences.js';
export {
  isPermissionKey,
  isPrivilegedPermission,
  isScope,
  isSensitiveCommercialPermission,
  PERMISSION_KEYS,
  PRIVILEGED_PERMISSIONS,
  SCOPES,
  SENSITIVE_COMMERCIAL_PERMISSIONS,
} from './permissions.js';
export type { PermissionKey, Scope } from './permissions.js';
export { MFA_AT_LOGIN_ROLE_KEYS, SYSTEM_ROLE_KEYS, SYSTEM_ROLE_NAMES, SYSTEM_ROLE_TEMPLATES } from './roles.js';
export type { PermissionGrant, SystemRoleKey, SystemRoleTemplate } from './roles.js';
export { redisConnectionOptions } from './redis-connection.js';
export type { RedisConnectionOptions } from './redis-connection.js';
export { TimeoutError, withTimeout } from './with-timeout.js';

export const APP_NAME = 'Company Operations Hub';

export const REQUEST_ID_HEADER = 'x-request-id';

export const CSRF_HEADER = 'x-csrf-token';

/** HttpOnly session cookie set by the API (SECURITY §3.3). The web app only checks its presence. */
export const SESSION_COOKIE = '__Host-ops_sid';

/** Non-secret UI language preference cookie written by the web app (UI_UX.md §8). */
export const LOCALE_COOKIE = 'ops_locale';
