import { Inject, Injectable, Logger, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown, Provider } from '@nestjs/common';

import {
  ApprovalService,
  AsyncLocalTenantContext,
  AttendanceCorrectionService,
  AttendancePolicyService,
  AttendanceService,
  AttachmentService,
  DelegationService,
  RequestAttachmentPolicy,
  RequestService,
  RequestTypeAdminService,
  createJiraRuntime,
  createTenantScopedClient,
  AuditQueryService,
  CustomerService,
  DailyReportAttachmentPolicy,
  DailyReportService,
  DashboardCache,
  DashboardService,
  DepartmentService,
  EmployeeAvatarPolicy,
  EmployeeService,
  EnvelopeCipher,
  FailedOutboxService,
  createGithubRuntime,
  GithubAdminService,
  GithubProjectService,
  GithubSetupService,
  GithubTicketService,
  GithubWebhookIntake,
  JiraAdminService,
  JiraConnectionService,
  JiraLinksService,
  JiraOverviewService,
  JiraWebhookIntake,
  JobTitleService,
  NeedsAttentionService,
  NO_SCAN,
  NotificationPreferenceService,
  NotificationService,
  OrganizationSettingsService,
  ProjectActivityService,
  ProjectLocationService,
  ProjectMemberService,
  PrismaClient,
  ProjectService,
  loadAppPrivateKey,
  redisDashboardCacheStore,
  redisKeyValueStore,
  RetentionPolicyService,
  RoleAdminService,
  RoleGrantService,
  S3Storage,
  SearchService,
  SetupChecklistService,
  ShiftService,
  SupportConfigService,
  SupportTicketAttachmentPolicy,
  TeamService,
  TicketCommentService,
  TicketService,
  TicketWatcherService,
  WorkLocationService,
  AmendmentService,
  CommercialDocumentAttachmentPolicy,
  CommercialDocumentService,
  CommercialReportService,
  CommercialSettingsService,
  ContractMilestoneAttachmentPolicy,
  ContractService,
  ContractWorkService,
  CorporateDocumentAttachmentPolicy,
  CorporateDocumentService,
  GuaranteeAttachmentPolicy,
  GuaranteeService,
  ObligationOccurrenceAttachmentPolicy,
  ProjectCommercialService,
  TenderRequirementAttachmentPolicy,
  TenderRequirementService,
  TenderReviewService,
  TenderService,
} from '@company-ops/core';
import type {
  GithubAppSettings,
  GithubRuntime,
  JiraAppSettings,
  JiraRuntime,
  TenantContextAccessor,
  TenantScopedClient,
} from '@company-ops/core';
import type { Redis } from 'ioredis';

import type { ApiEnv } from '../config/api-env.js';
import { REDIS } from '../infrastructure/infrastructure.module.js';
import { ActionContextFactory } from '../tenancy/action-context.factory.js';
import { ClsTenantContext } from '../tenancy/cls-tenant-context.js';
import { TENANT_DB } from '../tenancy/tenancy.module.js';
import { AttachmentsController } from './attachments.controller.js';
import { AttendanceController, AttendancePolicyController, ShiftsController } from './attendance.controller.js';
import { AuditController } from './audit.controller.js';
import {
  CommercialController,
  CommercialDocumentsController,
  CorporateDocumentsController,
  GuaranteesController,
  ProjectCommercialController,
} from './commercial.controller.js';
import { ContractsController } from './contracts.controller.js';
import { CustomersController } from './customers.controller.js';
import {
  DashboardController,
  NotificationPreferencesController,
  SearchController,
  SetupChecklistController,
} from './dashboard.controller.js';
import { DepartmentsController } from './departments.controller.js';
import { EmployeesController } from './employees.controller.js';
import { FailedJobsController } from './failed-jobs.controller.js';
import { FailedJobsService } from './failed-jobs.service.js';
import {
  GithubIntegrationController,
  GithubWebhookController,
  ProjectGithubController,
  RetentionPoliciesController,
  TicketGithubController,
} from './github.controller.js';
import {
  JiraIntegrationController,
  JiraWebhookController,
  ProjectJiraController,
  TicketJiraController,
} from './jira.controller.js';
import { JobTitlesController } from './job-titles.controller.js';
import { MeProfileController } from './me-profile.controller.js';
import { NotificationsController } from './notifications.controller.js';
import { OrganizationController } from './organization.controller.js';
import { DailyReportsController, EmployeeProjectsController, ProjectsController } from './projects.controller.js';
import { RealtimeController } from '../realtime/realtime.controller.js';
import { RealtimeHub } from '../realtime/realtime-hub.js';
import {
  ApprovalDelegationsController,
  ApprovalsController,
  RequestAdminController,
  RequestsController,
  RequestTypesController,
} from './requests.controller.js';
import { RolesController } from './roles.controller.js';
import { ProjectSupportController, SupportConfigController, SupportTicketsController } from './support.controller.js';
import { TeamsController } from './teams.controller.js';
import { TendersController } from './tenders.controller.js';
import { WorkLocationsController } from './work-locations.controller.js';

/** Core services that only need the tenant-scoped client and the request tenant context. */
type TenantService = new (db: TenantScopedClient, tenant: TenantContextAccessor) => object;

const tenantService = (service: TenantService): Provider => ({
  provide: service,
  useFactory: (db: TenantScopedClient, tenant: ClsTenantContext) => new service(db, tenant),
  inject: [TENANT_DB, ClsTenantContext],
});

export const JIRA_RUNTIME = Symbol('JIRA_RUNTIME');

function jiraSettings(env: ApiEnv): JiraAppSettings | null {
  if (env.JIRA_OAUTH_CLIENT_ID === undefined || env.JIRA_OAUTH_CLIENT_SECRET === undefined) {
    return null;
  }
  return {
    clientId: env.JIRA_OAUTH_CLIENT_ID,
    clientSecret: env.JIRA_OAUTH_CLIENT_SECRET,
    authBaseUrl: env.JIRA_AUTH_BASE_URL,
    apiBaseUrl: env.JIRA_API_BASE_URL,
    publicUrl: env.APP_PUBLIC_URL,
  };
}

export const GITHUB_RUNTIME = Symbol('GITHUB_RUNTIME');

/** Null when the GitHub App is not configured (the env schema enforces all-or-nothing credentials). */
function githubSettings(env: ApiEnv): GithubAppSettings | null {
  if (
    env.GITHUB_APP_ID === undefined ||
    env.GITHUB_APP_CLIENT_ID === undefined ||
    env.GITHUB_APP_PRIVATE_KEY === undefined
  ) {
    return null;
  }
  return {
    appId: env.GITHUB_APP_ID,
    clientId: env.GITHUB_APP_CLIENT_ID,
    privateKey: loadAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY),
    clientSecret: env.GITHUB_APP_CLIENT_SECRET ?? null,
    slug: env.GITHUB_APP_SLUG ?? null,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? null,
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    webBaseUrl: env.GITHUB_WEB_BASE_URL,
    publicUrl: env.APP_PUBLIC_URL,
  };
}

@Injectable()
class StorageLifecycle implements OnApplicationShutdown {
  constructor(@Inject(S3Storage) private readonly storage: S3Storage) {}

  onApplicationShutdown(): void {
    this.storage.destroy();
  }
}

/**
 * HTTP surface: organization, people, roles, audit, notifications, attachments, admin (Phase 1);
 * customers, projects, membership, work locations, daily reports and activity (Phase 2); support
 * tickets, support configuration and the live-update stream (Phase 3); the Jira Cloud integration
 * (Phase 4); the GitHub integration (Phase 5); requests and approvals (Phase 6); attendance (Phase 7);
 * dashboards, Needs Attention, search, the setup checklist and notification preferences (Phase 8);
 * tenders, contracts, guarantees, the corporate document vault and commercial reports (Phase 10).
 */
@Module({})
export class FeaturesModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: FeaturesModule,
      controllers: [
        OrganizationController,
        MeProfileController,
        EmployeesController,
        EmployeeProjectsController,
        DepartmentsController,
        TeamsController,
        JobTitlesController,
        RolesController,
        AuditController,
        NotificationPreferencesController,
        NotificationsController,
        AttachmentsController,
        FailedJobsController,
        CustomersController,
        ProjectsController,
        DailyReportsController,
        WorkLocationsController,
        SupportTicketsController,
        SupportConfigController,
        ProjectSupportController,
        RealtimeController,
        JiraIntegrationController,
        JiraWebhookController,
        TicketJiraController,
        ProjectJiraController,
        GithubIntegrationController,
        GithubWebhookController,
        ProjectGithubController,
        TicketGithubController,
        RetentionPoliciesController,
        RequestAdminController,
        RequestTypesController,
        RequestsController,
        ApprovalsController,
        ApprovalDelegationsController,
        AttendanceController,
        AttendancePolicyController,
        ShiftsController,
        DashboardController,
        SearchController,
        SetupChecklistController,
        TendersController,
        ContractsController,
        CorporateDocumentsController,
        CommercialDocumentsController,
        GuaranteesController,
        CommercialController,
        ProjectCommercialController,
      ],
      providers: [
        ActionContextFactory,
        tenantService(OrganizationSettingsService),
        tenantService(EmployeeService),
        tenantService(DepartmentService),
        tenantService(TeamService),
        tenantService(JobTitleService),
        tenantService(RoleGrantService),
        tenantService(RoleAdminService),
        tenantService(AuditQueryService),
        tenantService(NotificationService),
        tenantService(FailedOutboxService),
        tenantService(CustomerService),
        tenantService(ProjectService),
        tenantService(ProjectMemberService),
        tenantService(ProjectLocationService),
        tenantService(ProjectActivityService),
        tenantService(WorkLocationService),
        tenantService(DailyReportService),
        tenantService(TicketService),
        tenantService(TicketCommentService),
        tenantService(TicketWatcherService),
        tenantService(SupportConfigService),
        tenantService(RequestService),
        tenantService(ApprovalService),
        tenantService(DelegationService),
        tenantService(RequestTypeAdminService),
        tenantService(AttendanceService),
        tenantService(AttendancePolicyService),
        tenantService(ShiftService),
        tenantService(SearchService),
        tenantService(SetupChecklistService),
        tenantService(NotificationPreferenceService),
        tenantService(TenderService),
        tenantService(TenderRequirementService),
        tenantService(TenderReviewService),
        tenantService(CommercialDocumentService),
        tenantService(CorporateDocumentService),
        tenantService(ContractService),
        tenantService(ContractWorkService),
        tenantService(GuaranteeService),
        tenantService(AmendmentService),
        tenantService(CommercialSettingsService),
        tenantService(CommercialReportService),
        {
          provide: ProjectCommercialService,
          useFactory: (
            db: TenantScopedClient,
            tenant: ClsTenantContext,
            work: ContractWorkService,
            guarantees: GuaranteeService,
          ) => new ProjectCommercialService(db, tenant, work, guarantees),
          inject: [TENANT_DB, ClsTenantContext, ContractWorkService, GuaranteeService],
        },
        {
          // Best-effort: any Redis error or timeout falls back to the source queries.
          provide: DashboardCache,
          useFactory: (redis: Redis) => {
            const logger = new Logger('DashboardCache');
            return new DashboardCache(redisDashboardCacheStore(redis), (operation, error) => {
              logger.warn({ err: error, operation }, 'Dashboard cache unavailable; computed from source');
            });
          },
          inject: [REDIS],
        },
        {
          provide: DashboardService,
          useFactory: (db: TenantScopedClient, tenant: ClsTenantContext, cache: DashboardCache) =>
            new DashboardService(db, tenant, cache),
          inject: [TENANT_DB, ClsTenantContext, DashboardCache],
        },
        {
          provide: NeedsAttentionService,
          useFactory: (db: TenantScopedClient, tenant: ClsTenantContext, cache: DashboardCache) =>
            new NeedsAttentionService(db, tenant, cache),
          inject: [TENANT_DB, ClsTenantContext, DashboardCache],
        },
        {
          provide: AttendanceCorrectionService,
          useFactory: (
            db: TenantScopedClient,
            tenant: ClsTenantContext,
            requests: RequestService,
            attendance: AttendanceService,
          ) => new AttendanceCorrectionService(db, tenant, requests, attendance),
          inject: [TENANT_DB, ClsTenantContext, RequestService, AttendanceService],
        },
        RealtimeHub,
        {
          provide: S3Storage,
          useFactory: () =>
            new S3Storage({
              endpoint: env.S3_ENDPOINT,
              publicEndpoint: env.S3_PUBLIC_ENDPOINT,
              region: env.S3_REGION,
              bucket: env.S3_BUCKET,
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              forcePathStyle: env.S3_FORCE_PATH_STYLE,
            }),
        },
        StorageLifecycle,
        {
          provide: AttachmentService,
          useFactory: (
            db: TenantScopedClient,
            tenant: ClsTenantContext,
            storage: S3Storage,
            employees: EmployeeService,
            reports: DailyReportService,
            comments: TicketCommentService,
            requests: RequestService,
            commercialDocuments: CommercialDocumentService,
            corporateDocuments: CorporateDocumentService,
            requirements: TenderRequirementService,
            work: ContractWorkService,
            guarantees: GuaranteeService,
          ) =>
            new AttachmentService(
              db,
              tenant,
              storage,
              [
                new EmployeeAvatarPolicy(employees),
                new DailyReportAttachmentPolicy(reports),
                new SupportTicketAttachmentPolicy(comments),
                new RequestAttachmentPolicy(requests),
                new CommercialDocumentAttachmentPolicy(commercialDocuments),
                new CorporateDocumentAttachmentPolicy(corporateDocuments),
                new TenderRequirementAttachmentPolicy(requirements),
                new ObligationOccurrenceAttachmentPolicy(work),
                new ContractMilestoneAttachmentPolicy(work),
                new GuaranteeAttachmentPolicy(guarantees),
              ],
              NO_SCAN,
            ),
          inject: [
            TENANT_DB,
            ClsTenantContext,
            S3Storage,
            EmployeeService,
            DailyReportService,
            TicketCommentService,
            RequestService,
            CommercialDocumentService,
            CorporateDocumentService,
            TenderRequirementService,
            ContractWorkService,
            GuaranteeService,
          ],
        },
        {
          provide: JIRA_RUNTIME,
          useFactory: (db: TenantScopedClient, cipher: EnvelopeCipher, redis: Redis): JiraRuntime | null => {
            const settings = jiraSettings(env);
            return settings === null
              ? null
              : createJiraRuntime({
                  settings,
                  fetch: (url, init) => fetch(url, init),
                  kv: redisKeyValueStore(redis),
                  db,
                  cipher,
                });
          },
          inject: [TENANT_DB, EnvelopeCipher, REDIS],
        },
        {
          provide: JiraConnectionService,
          useFactory: (
            db: TenantScopedClient,
            tenant: ClsTenantContext,
            runtime: JiraRuntime | null,
            cipher: EnvelopeCipher,
          ) => new JiraConnectionService(db, tenant, runtime, cipher),
          inject: [TENANT_DB, ClsTenantContext, JIRA_RUNTIME, EnvelopeCipher],
        },
        {
          provide: JiraAdminService,
          useFactory: (db: TenantScopedClient, tenant: ClsTenantContext, runtime: JiraRuntime | null) =>
            new JiraAdminService(db, tenant, runtime),
          inject: [TENANT_DB, ClsTenantContext, JIRA_RUNTIME],
        },
        {
          provide: JiraLinksService,
          useFactory: (db: TenantScopedClient, tenant: ClsTenantContext, runtime: JiraRuntime | null) =>
            new JiraLinksService(db, tenant, runtime, env.APP_PUBLIC_URL),
          inject: [TENANT_DB, ClsTenantContext, JIRA_RUNTIME],
        },
        {
          provide: JiraOverviewService,
          useFactory: (db: TenantScopedClient, tenant: ClsTenantContext) =>
            new JiraOverviewService(db, tenant, jiraSettings(env) !== null),
          inject: [TENANT_DB, ClsTenantContext],
        },
        {
          // Webhooks arrive without a session: the tenant is derived from the connection row and
          // bound with an async-local context for the duration of the intake.
          provide: JiraWebhookIntake,
          useFactory: (prisma: PrismaClient): JiraWebhookIntake | null => {
            const settings = jiraSettings(env);
            if (settings === null) {
              return null;
            }
            const tenant = new AsyncLocalTenantContext();
            return new JiraWebhookIntake(
              prisma,
              createTenantScopedClient(prisma, tenant),
              tenant,
              settings.clientSecret,
            );
          },
          inject: [PrismaClient],
        },
        tenantService(GithubTicketService),
        tenantService(RetentionPolicyService),
        {
          provide: GITHUB_RUNTIME,
          useFactory: (cipher: EnvelopeCipher, redis: Redis): GithubRuntime | null => {
            const settings = githubSettings(env);
            return settings === null
              ? null
              : createGithubRuntime({
                  settings,
                  fetch: (url, init) => fetch(url, init),
                  kv: redisKeyValueStore(redis),
                  cipher,
                });
          },
          inject: [EnvelopeCipher, REDIS],
        },
        {
          provide: GithubSetupService,
          useFactory: (
            prisma: PrismaClient,
            db: TenantScopedClient,
            tenant: ClsTenantContext,
            runtime: GithubRuntime | null,
          ) => new GithubSetupService(prisma, db, tenant, runtime),
          inject: [PrismaClient, TENANT_DB, ClsTenantContext, GITHUB_RUNTIME],
        },
        {
          provide: GithubAdminService,
          useFactory: (db: TenantScopedClient, tenant: ClsTenantContext, runtime: GithubRuntime | null) =>
            new GithubAdminService(db, tenant, runtime),
          inject: [TENANT_DB, ClsTenantContext, GITHUB_RUNTIME],
        },
        {
          provide: GithubProjectService,
          useFactory: (db: TenantScopedClient, tenant: ClsTenantContext, runtime: GithubRuntime | null) =>
            new GithubProjectService(db, tenant, runtime !== null),
          inject: [TENANT_DB, ClsTenantContext, GITHUB_RUNTIME],
        },
        {
          // Like Jira: no session on webhooks; the tenant comes from the persisted installation binding.
          provide: GithubWebhookIntake,
          useFactory: (prisma: PrismaClient): GithubWebhookIntake | null => {
            const secret = githubSettings(env)?.webhookSecret ?? null;
            if (secret === null) {
              return null;
            }
            const tenant = new AsyncLocalTenantContext();
            return new GithubWebhookIntake(prisma, createTenantScopedClient(prisma, tenant), tenant, secret);
          },
          inject: [PrismaClient],
        },
        FailedJobsService,
      ],
    };
  }
}
