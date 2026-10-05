export {
  bumpDashboardVersions,
  DASHBOARD_CACHE_TIMEOUT_MS,
  DASHBOARD_CACHE_TTL_SECONDS,
  DashboardCache,
  dashboardInvalidator,
  InMemoryDashboardCacheStore,
  redisDashboardCacheStore,
} from './dashboard-cache.js';
export type {
  CachedRead,
  CacheErrorReporter,
  DashboardCacheStore,
  DashboardInvalidator,
  DashboardRedisCommands,
} from './dashboard-cache.js';
export { DashboardService, TREND_ROW_CAP } from './dashboard.service.js';
export type {
  CommercialDashboard,
  DailyReportDueItem,
  ExecutiveDashboard,
  MeDashboard,
  MyProjectItem,
  ProjectsDashboard,
  SupportDashboard,
  TeamDashboard,
  Trend,
  TrendMetric,
} from './dashboard.service.js';
export {
  ACTIVE_PROJECT_STATUSES,
  approvalsSection,
  attendanceTodaySection,
  developmentSection,
  githubSignals,
  jiraSignals,
  projectsSection,
  supportSection,
  worksTickets,
} from './dashboard-sections.js';
export type {
  ApprovalsSection,
  AttendanceTodaySection,
  DevelopmentSection,
  GithubSignals,
  IntegrationFreshness,
  JiraSignals,
  ProjectsSection,
  ProjectWatchItem,
  SupportSection,
} from './dashboard-sections.js';
export { MISSING_REPORT_PROJECT_CAP, missingReportsToday, ownReportsDue } from './daily-reports-today.js';
export type { OwnReportDue } from './daily-reports-today.js';
export { NeedsAttentionService } from './needs-attention.service.js';
export type { NeedsAttention } from './needs-attention.service.js';
export { SEARCH_TYPES, SearchService } from './search.service.js';
export type { SearchGroup, SearchInput, SearchResponse, SearchResult, SearchType } from './search.service.js';
export { SetupChecklistService } from './setup-checklist.service.js';
export type { SetupChecklist } from './setup-checklist.service.js';
export { dashboardLink, supportLink } from './links.js';
export type { DashboardLink, DashboardMetric, SupportMetricFilter } from './links.js';
export {
  ATTENTION_CAP,
  compareAttention,
  dedupeAttention,
  prioritizeAttention,
  SEVERITY_RANK,
} from './engine/attention.js';
export type { AttentionItem, AttentionScope, AttentionSeverity, AttentionType } from './engine/attention.js';
export {
  DASHBOARD_DOMAINS,
  dashboardCacheKey,
  scopeDescriptor,
  scopeHash,
  versionKey,
  versionsTag,
} from './engine/cache-keys.js';
export type { DashboardDomain } from './engine/cache-keys.js';
export { deriveChecklist } from './engine/checklist.js';
export type { SetupFacts, SetupItem, SetupItemKey } from './engine/checklist.js';
export { bucketDates, bucketInstants, localDayWindow, RANGE_DAYS, rangeDates, rangeWindow } from './engine/ranges.js';
export type { TrendRange } from './engine/ranges.js';
export {
  decodeSearchCursor,
  encodeSearchCursor,
  matchTier,
  normalizeSearchQuery,
  rankResults,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LENGTH,
  SEARCH_MAX_OFFSET,
  SEARCH_MIN_LENGTH,
} from './engine/search.js';
export { escapeLike } from '../../platform/db/like.js';
