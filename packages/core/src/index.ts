export {
  AttachmentOwnerType,
  AttachmentScanStatus,
  AttachmentStatus,
  AuditActorType,
  createPrismaClient,
  CustomerType,
  DailyReportStatus,
  EmploymentStatus,
  EmploymentType,
  MemberStatus,
  NotificationSeverity,
  OrgStatus,
  PermissionScope,
  PlatformAuditActorType,
  PlatformRole,
  Prisma,
  PrismaClient,
  ProjectActivitySource,
  ProjectHealth,
  ProjectRole,
  ProjectStatus,
  WorkLocationType,
  EscalationTrigger,
  NotificationChannel,
  NotificationDeliveryStatus,
  SlaEventKind,
  SlaState,
  TicketCommentVisibility,
  TicketImpact,
  TicketPriority,
  TicketSeverity,
  TicketSource,
  TicketStatus,
} from './platform/db/prisma.js';
export { pingDatabase } from './platform/db/sql/connectivity.js';
export {
  claimOutboxEvents,
  markOutboxEventDispatched,
  markOutboxEventFailed,
  outboxBacklog,
} from './platform/db/sql/outbox.js';
export type { ClaimedOutboxEvent, OutboxBacklog } from './platform/db/sql/outbox.js';
export { MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from './platform/observability/metrics.js';
export type { Counter, Histogram } from './platform/observability/metrics.js';
export { startOpsServer } from './platform/observability/ops-server.js';
export type { OpsRoute, OpsServer } from './platform/observability/ops-server.js';
export { expiredPendingAttachments } from './platform/db/sql/attachment-maintenance.js';
export { QUEUE_NAMES } from './platform/queues/queue-names.js';
export type { QueueName } from './platform/queues/queue-names.js';
export { enqueueOutboxEvent, isOutboxEventType, OUTBOX_ROUTES, outboxJobId } from './platform/outbox/outbox.js';
export type {
  ActivitySource,
  AttachmentObjectDeletePayload,
  GithubInstallationSyncPayload,
  GithubSyncRequestedPayload,
  GithubWebhookReceivedPayload,
  NotificationEmailRequestedPayload,
  NotificationRequestedPayload,
  TicketChangedPayload,
  ProjectActivityRecordedPayload,
  OutboxEventPayloads,
  OutboxEventType,
  OutboxJobData,
} from './platform/outbox/outbox.js';

export {
  ConflictError,
  DomainError,
  ForbiddenError,
  InvalidFieldsError,
  InvalidInputError,
  InvalidTransitionError,
  NotFoundError,
  TenantIsolationError,
  VersionConflictError,
} from './platform/errors.js';
export type { DomainFieldError } from './platform/errors.js';
export {
  AsyncLocalTenantContext,
  requireAnyTenantContext,
  requireTenantContext,
} from './platform/tenancy/tenant-context.js';
export type {
  AnyTenantContext,
  SystemTenantContext,
  TenantContext,
  TenantContextAccessor,
} from './platform/tenancy/tenant-context.js';
export {
  activeOrganizationId,
  assertTenantSafeOperation,
  createTenantScopedClient,
} from './platform/tenancy/tenant-guard.js';
export type { TenantDb, TenantScopedClient } from './platform/tenancy/tenant-guard.js';
export { MODEL_TENANCY } from './platform/tenancy/tenant-models.js';
export type { ModelTenancy } from './platform/tenancy/tenant-models.js';
export { EnvelopeCipher } from './platform/crypto/envelope-cipher.js';
export type { EncryptionKey } from './platform/crypto/envelope-cipher.js';
export { recordAudit, recordPlatformAudit } from './platform/audit/audit-writer.js';
export type {
  AuditActor,
  AuditEntry,
  AuditRequestContext,
  PlatformAuditActor,
  PlatformAuditEntry,
} from './platform/audit/audit-writer.js';
export { redactAuditMetadata } from './platform/audit/redact.js';
export { DEFAULT_PAGE_SIZE, decodeCursor, encodeCursor, MAX_PAGE_SIZE } from './platform/pagination/cursor.js';
export type { Page } from './platform/pagination/cursor.js';
export { NO_SCAN } from './platform/storage/storage-port.js';
export type { AttachmentScanner, StoragePort } from './platform/storage/storage-port.js';
export { S3Storage } from './platform/storage/s3-storage.js';
export type { S3StorageConfig } from './platform/storage/s3-storage.js';

export {
  computeEffectivePermissions,
  deserializePermissions,
  hasPermission,
  holdsPrivilegedPermission,
  scopesFor,
  serializePermissions,
} from './modules/authorization/effective-permissions.js';
export type {
  EffectivePermissions,
  GrantRow,
  SerializedPermissions,
} from './modules/authorization/effective-permissions.js';
export {
  assertPermission,
  canAccessResource,
  EMPTY_REACH,
  isEmptyListScope,
  listScope,
  needsReach,
} from './modules/authorization/policy.js';
export type { ListScope, Principal, ResourceFacts, ScopeReach } from './modules/authorization/policy.js';
export { ScopeReachResolver } from './modules/authorization/scope-reach.js';
export type { PrincipalBase } from './modules/authorization/scope-reach.js';
export { isMfaSatisfied, MFA_ACR, requiresMfaAtLogin } from './modules/authorization/mfa.js';
export type { AuthenticationLevel } from './modules/authorization/mfa.js';
export type { ActionContext } from './modules/action-context.js';
export { IdentityService } from './modules/identity/identity.service.js';
export type {
  MemberAuthzState,
  MemberPrincipal,
  MembershipSummary,
  VerifiedIdentity,
} from './modules/identity/identity.service.js';
export {
  InvalidOrganizationInputError,
  isValidTimeZone,
  materializeSystemRoles,
  provisionOrganization,
} from './modules/organizations/provision-organization.js';
export type { NewOrganization, ProvisionedOrganization } from './modules/organizations/provision-organization.js';
export { bootstrapOrganization } from './modules/organizations/bootstrap-organization.js';
export type { BootstrapInput, BootstrapOutcome } from './modules/organizations/bootstrap-organization.js';
export { OrganizationSettingsService } from './modules/organizations/organization-settings.service.js';
export type { OrganizationChanges, OrganizationView } from './modules/organizations/organization-settings.service.js';
export { MemberRepository } from './modules/access/member.repository.js';
export type { MemberListFilter, MemberView } from './modules/access/member.repository.js';
export { RoleGrantService } from './modules/access/role-grant.service.js';
export { RoleAdminService } from './modules/access/role-admin.service.js';
export type { CreateRoleInput, RoleGrantInput, UpdateRoleInput } from './modules/access/role-admin.service.js';
export type { MemberRoleView, RoleGrantResult, RoleView } from './modules/access/role-grant.service.js';
export { ADMIN_ROLE_KEY, isAdministratorEquivalent } from './modules/access/administrators.js';
export { EmployeeService, employeeFacts } from './modules/people/employee.service.js';
export type {
  EmployeeChanges,
  EmployeeListFilter,
  EmployeeView,
  IssuedInvitation,
  NewEmployee,
  OwnProfileChanges,
} from './modules/people/employee.service.js';
export { DepartmentService, MAX_STRUCTURE_LIST } from './modules/people/department.service.js';
export type { DepartmentInput, DepartmentView } from './modules/people/department.service.js';
export { TeamService } from './modules/people/team.service.js';
export type { TeamInput, TeamMemberView, TeamView } from './modules/people/team.service.js';
export { JobTitleService } from './modules/people/job-title.service.js';
export type { JobTitleView } from './modules/people/job-title.service.js';
export { InvitationRedemptionService } from './modules/people/invitation-redemption.service.js';
export type { InvitationRedemption } from './modules/people/invitation-redemption.service.js';
export {
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
  isWellFormedInvitationToken,
} from './modules/people/invitation-token.js';
export { AVATAR_MAX_BYTES, EmployeeAvatarPolicy } from './modules/people/employee-avatar.policy.js';
export { FailedOutboxService, MAX_FAILED_LIST } from './modules/jobs/failed-outbox.service.js';
export type { FailingOutboxEventView } from './modules/jobs/failed-outbox.service.js';
export { AuditQueryService } from './modules/audit/audit-query.service.js';
export type { AuditEventFilter, AuditEventView } from './modules/audit/audit-query.service.js';
export { NotificationService, NotificationWriter } from './modules/notifications/notification.service.js';
export type { NotificationView, NotificationWriteResult } from './modules/notifications/notification.service.js';
export {
  AttachmentService,
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
} from './modules/attachments/attachment.service.js';
export type {
  AttachmentOwnerPolicy,
  AttachmentView,
  OwnerAccess,
  UploadIntent,
} from './modules/attachments/attachment.service.js';
export { MAX_OWNER_ATTACHMENTS } from './modules/attachments/attachment.service.js';
export { organizationsRequiringDailyReports } from './platform/db/sql/daily-report-check.js';
export { organizationsWithOpenTickets, organizationsWithOverdueApprovals } from './platform/db/sql/support-sweep.js';
export { loadMemberAccess } from './modules/authorization/member-access.js';
export type { MemberAccess } from './modules/authorization/member-access.js';
export { NO_REALTIME, permissionChannel, publishQuietly, userChannel } from './platform/realtime/realtime.js';
export type { RealtimeEvent, RealtimePublisher } from './platform/realtime/realtime.js';
export { DISABLED_EMAIL } from './platform/email/email-channel.js';
export type { EmailChannel, EmailMessage } from './platform/email/email-channel.js';
export {
  EMAIL_NOTIFICATION_TYPES,
  escapeHtml,
  renderNotificationEmail,
} from './modules/notifications/email-templates.js';
export {
  DELIVERY_CLAIM_TIMEOUT_MS,
  DeliveryInProgressError,
  NOT_AUTHORIZED_REASON,
  NotificationDeliveryService,
} from './modules/notifications/notification-delivery.js';
export type { DeliveryOutcome } from './modules/notifications/notification-delivery.js';
export { notificationEntityAccess } from './modules/notifications/notification-entity-access.js';
export type { NotificationEntityAccess } from './modules/notifications/notification-entity-access.js';
export { DEFAULT_PRIORITY, TICKET_VIEWS, ticketAccess, TicketService } from './modules/support/ticket.service.js';
export type {
  AssignTicketInput,
  CreateTicketInput,
  ProjectSupportSummary,
  TicketEventView,
  TicketListFilter,
  TicketQueueView,
  TicketSort,
  TransitionTicketInput,
  UpdateTicketInput,
} from './modules/support/ticket.service.js';
export type {
  TicketAccess,
  TicketPersonRef,
  TicketSlaView,
  TicketSummaryView,
  TicketView,
} from './modules/support/ticket-views.js';
export {
  SupportTicketAttachmentPolicy,
  TICKET_ATTACHMENT_MAX_BYTES,
  TicketCommentService,
} from './modules/support/ticket-comment.service.js';
export type { TicketCommentView } from './modules/support/ticket-comment.service.js';
export { TicketWatcherService } from './modules/support/ticket-watcher.service.js';
export type { TicketWatcherView } from './modules/support/ticket-watcher.service.js';
export { SupportConfigService } from './modules/support/support-config.service.js';
export type {
  BusinessCalendarView,
  CalendarInput,
  ComponentInput,
  EscalationRuleInput,
  EscalationRuleView,
  SlaPolicyInput,
  SlaPolicyView,
  SupportCategoryView,
  SupportComponentView,
  TaxonomyInput,
  TicketMatchInput,
} from './modules/support/support-config.service.js';
export { SLA_SWEEP_BATCH_SIZE, SlaSweep } from './modules/support/sla-sweep.js';
export type { SlaSweepResult } from './modules/support/sla-sweep.js';
export {
  isOpenStatus,
  LOCKED_TICKET_STATUSES,
  mayTransition,
  nextStatuses,
  OPEN_TICKET_STATUSES,
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  transitionRule,
} from './modules/support/ticket-state-machine.js';
export type { TransitionKind, TransitionRule } from './modules/support/ticket-state-machine.js';
export {
  addClockSeconds,
  clockSecondsBetween,
  hasWorkingTime,
  WALL_CLOCK,
  zonedTimeToUtc,
} from './modules/support/sla-clock.js';
export type { BusinessCalendarSpec, SlaClock, WorkingWindow } from './modules/support/sla-clock.js';
export {
  calendarSpec,
  matchesTicket,
  parseEscalationNotify,
  parseHolidays,
  parseTicketMatch,
  parseWorkingHours,
  policyClock,
} from './modules/support/sla-config.js';
export type { SlaPolicyClock, TicketMatch, WorkingHoursEntry } from './modules/support/sla-config.js';
export { applyStatusChange, dueDates, escalationTriggered, evaluateSla } from './modules/support/sla-evaluator.js';
export type { SlaEvaluation, SlaSnapshot } from './modules/support/sla-evaluator.js';
export { ticketKey } from './modules/support/ticket-access.js';
export { ticketRealtimeAudience } from './modules/support/ticket-notify.js';
export { INTERNAL_EVENT_TYPES, TICKET_EVENT_TYPES } from './modules/support/ticket-history.js';
export { CustomerService } from './modules/projects/customer.service.js';
export type { CustomerInput, CustomerListFilter, CustomerView } from './modules/projects/customer.service.js';
export { ProjectService } from './modules/projects/project.service.js';
export type {
  EmployeeProjectView,
  PersonRef,
  ProjectAccess,
  ProjectDetailsInput,
  ProjectListFilter,
  ProjectSort,
  ProjectSummaryView,
  ProjectView,
} from './modules/projects/project.service.js';
export { MANAGER_PROJECT_ROLES, ProjectMemberService } from './modules/projects/project-member.service.js';
export type { ProjectMemberInput, ProjectMemberView } from './modules/projects/project-member.service.js';
export { ProjectLocationService, WorkLocationService } from './modules/projects/work-location.service.js';
export type {
  ProjectLocationView,
  WorkLocationInput,
  WorkLocationView,
} from './modules/projects/work-location.service.js';
export {
  DAILY_REPORT_ATTACHMENT_MAX_BYTES,
  DAILY_REPORT_BACKFILL_DAYS,
  DailyReportAttachmentPolicy,
  DailyReportMissingCheck,
  DailyReportService,
  MISSING_REPORT_MAX_RANGE_DAYS,
} from './modules/projects/daily-report.service.js';
export type {
  DailyReportInput,
  DailyReportListFilter,
  DailyReportSummaryView,
  DailyReportView,
  MissingCheckResult,
  MissingReportsView,
  ReporterRef,
} from './modules/projects/daily-report.service.js';
export {
  parseActivityPayload,
  ProjectActivityService,
  ProjectActivityWriter,
} from './modules/projects/project-activity.js';
export type { ActivityWriteResult, ProjectActivityView } from './modules/projects/project-activity.js';
export { DEFAULT_DAILY_REPORT_POLICY, PROJECT_ROLES } from './modules/projects/daily-report-policy.js';
export type { DailyReportPolicy } from './modules/projects/daily-report-policy.js';
export { REPORTING_STATUSES } from './modules/projects/missing-reports.js';
export { STATUS_TRANSITIONS } from './modules/projects/project-lifecycle.js';
export {
  contentDisposition,
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  inspectContent,
  sanitizeFilename,
  verifyContentType,
} from './modules/attachments/attachment-content.js';
export * from './modules/jira/index.js';
export * from './platform/db/sql/jira-scan.js';
export * from './modules/github/index.js';
export * from './platform/db/sql/github-scan.js';
export * from './modules/retention/retention.service.js';
export * from './modules/requests/index.js';
export * from './modules/attendance/index.js';
export { organizationsWithOpenAttendance } from './platform/db/sql/attendance.js';
export * from './modules/dashboard/index.js';
export * from './modules/commercial/index.js';
export { organizationsWithCommercialRecords } from './platform/db/sql/commercial.js';
export { csvCell, toCsv } from './platform/csv.js';
export {
  loadPreferenceLookup,
  NotificationPreferenceService,
} from './modules/notifications/notification-preferences.js';
export type { NotificationPreferenceItem, PreferenceChange } from './modules/notifications/notification-preferences.js';

export { DEMO_ORGANIZATION, DEMO_USERS } from './dev-seed/demo-data.js';
export type { DemoUser } from './dev-seed/demo-data.js';
export { DEMO_EMPLOYEES, SECOND_ORGANIZATION } from './dev-seed/demo-people.js';
export { assertSeedAllowed, SeedRefusedError, seedDemoData } from './dev-seed/seed.js';
export type { SeedReport } from './dev-seed/seed.js';
