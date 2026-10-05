/**
 * Stable API error codes (ARCHITECTURE §8.1). Domain-specific codes are added by the phase that
 * introduces the rule.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  CSRF_INVALID: 'CSRF_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  /** Phase 4: the deployment has no Jira OAuth app configured. */
  JIRA_NOT_CONFIGURED: 'JIRA_NOT_CONFIGURED',
  /** Phase 4: the organization has no usable Jira connection (or the project has no mapping). */
  JIRA_NOT_CONNECTED: 'JIRA_NOT_CONNECTED',
  /** Phase 4: Jira rejected the stored grant; an administrator must reconnect. */
  JIRA_REAUTH_REQUIRED: 'JIRA_REAUTH_REQUIRED',
  /** Phase 4: Jira is rate limiting, failing or unreachable; retry later. */
  JIRA_UNAVAILABLE: 'JIRA_UNAVAILABLE',
  /** Phase 4: Jira refused the request (validation, permissions of the connected account). */
  JIRA_REQUEST_REJECTED: 'JIRA_REQUEST_REJECTED',
  /** Phase 4: an earlier create attempt with this key may have created an issue; check Jira and link it. */
  JIRA_CREATE_OUTCOME_UNKNOWN: 'JIRA_CREATE_OUTCOME_UNKNOWN',
  /** Phase 4: a sync run is already queued or running for the mapping. */
  JIRA_SYNC_IN_PROGRESS: 'JIRA_SYNC_IN_PROGRESS',
  /** Phase 5: the deployment has no GitHub App configured. */
  GITHUB_NOT_CONFIGURED: 'GITHUB_NOT_CONFIGURED',
  /** Phase 5: the installation setup could not be verified (state, session or GitHub identity); start again. */
  GITHUB_SETUP_INVALID: 'GITHUB_SETUP_INVALID',
  /** Phase 5: the installation is already bound to another organization. */
  GITHUB_INSTALLATION_CONFLICT: 'GITHUB_INSTALLATION_CONFLICT',
  /** Phase 5: the installation (or repository) is suspended, removed or disconnected. */
  GITHUB_INSTALLATION_INACTIVE: 'GITHUB_INSTALLATION_INACTIVE',
  /** Phase 5: GitHub is rate limiting, failing or unreachable; retry later. */
  GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',
  /** Phase 5: GitHub refused the request. */
  GITHUB_REQUEST_REJECTED: 'GITHUB_REQUEST_REJECTED',
  /** Phase 5: a sync run is already queued or running for the repository. */
  GITHUB_SYNC_IN_PROGRESS: 'GITHUB_SYNC_IN_PROGRESS',
  /** Phase 6: no eligible approver could be resolved for a step of the workflow; nothing was submitted. */
  REQUEST_APPROVER_UNRESOLVED: 'REQUEST_APPROVER_UNRESOLVED',
  /** Phase 6: the draft was filled in against a workflow version that is no longer current; reload the form. */
  REQUEST_FORM_OUTDATED: 'REQUEST_FORM_OUTDATED',
  /** Phase 6: the approval was already decided (by this or another approver) or the step moved on. */
  REQUEST_ALREADY_DECIDED: 'REQUEST_ALREADY_DECIDED',
  /** Phase 6: the workflow configuration cannot be published (see the field errors). */
  WORKFLOW_INVALID: 'WORKFLOW_INVALID',
  /** Phase 7: no accuracy policy saved yet; location check-ins are refused until an administrator sets one. */
  ATTENDANCE_NOT_CONFIGURED: 'ATTENDANCE_NOT_CONFIGURED',
  /** Phase 7: the member has no active employee profile and cannot record attendance. */
  ATTENDANCE_NOT_ELIGIBLE: 'ATTENDANCE_NOT_ELIGIBLE',
  /** Phase 7: the reported position is outside every eligible work location. */
  ATTENDANCE_OUTSIDE_GEOFENCE: 'ATTENDANCE_OUTSIDE_GEOFENCE',
  /** Phase 7: the reported accuracy is worse than the organization accepts (policy REJECT). */
  ATTENDANCE_LOW_ACCURACY: 'ATTENDANCE_LOW_ACCURACY',
  /** Phase 7: a location is required for this check-in and none was available (policy REJECT). */
  ATTENDANCE_LOCATION_REQUIRED: 'ATTENDANCE_LOCATION_REQUIRED',
  /** Phase 7: no active work location is eligible for this employee. */
  ATTENDANCE_NO_LOCATION: 'ATTENDANCE_NO_LOCATION',
  ATTENDANCE_ALREADY_CHECKED_IN: 'ATTENDANCE_ALREADY_CHECKED_IN',
  ATTENDANCE_NOT_CHECKED_IN: 'ATTENDANCE_NOT_CHECKED_IN',
  ATTENDANCE_ALREADY_CHECKED_OUT: 'ATTENDANCE_ALREADY_CHECKED_OUT',
  /** Phase 7: an approved full-day leave covers the day. */
  ATTENDANCE_ON_LEAVE: 'ATTENDANCE_ON_LEAVE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Default code for an HTTP status when the thrower did not provide a specific one. */
export function defaultErrorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return ERROR_CODES.VALIDATION_FAILED;
    case 401:
      return ERROR_CODES.UNAUTHENTICATED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    case 502:
    case 503:
    case 504:
      return ERROR_CODES.DEPENDENCY_UNAVAILABLE;
    default:
      return ERROR_CODES.INTERNAL_ERROR;
  }
}
