'use client';

import {
  AlertOctagonIcon,
  AlertTriangleIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  InfoIcon,
  RefreshCwIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Label, NativeSelect } from '@company-ops/ui/components/input';
import { Skeleton } from '@company-ops/ui/components/skeleton';
import { cn } from '@company-ops/ui/lib/utils';

import { TREND_RANGES, useNeedsAttention, useTrend } from '../lib/dashboard';
import type {
  AttendanceTodaySection,
  AttentionItem,
  DashboardMetric,
  DevelopmentSection,
  MeDashboard,
  ProjectsSection,
  SupportSection,
  TrendMetric,
  TrendRange,
} from '../lib/dashboard';
import { useDateFormat } from '../lib/format';
import { linkHref, oneOf } from '../lib/link-params';
import { useSession } from '../lib/session';
import { ProjectHealthBadge } from './projects';
import { EmptyState, ErrorState } from './states';

// ---- Access (UX only: every endpoint re-checks; a hidden card is never the security boundary) ----

export interface DashboardAccess {
  readonly support: boolean;
  readonly projects: boolean;
  readonly team: boolean;
  readonly executive: boolean;
}

export function useDashboardAccess(): DashboardAccess {
  const me = useSession();
  const has = (key: string) => me.permissions.some((grant) => grant.key === key);
  return {
    support: me.permissions.some(
      (grant) => grant.key === 'support.view' && grant.scopes.some((scope) => scope !== 'SELF'),
    ),
    projects: has('dashboard.project'),
    team: has('attendance.team'),
    executive: has('dashboard.executive'),
  };
}

// ---- Building blocks ----

/** One number and the list it opens; the link reproduces exactly the rows counted. */
export function MetricTile({
  label,
  metric,
  description,
  tone = 'neutral',
  testId,
}: {
  readonly label: string;
  readonly metric: DashboardMetric | number;
  readonly description?: string;
  readonly tone?: 'neutral' | 'warning' | 'danger';
  readonly testId?: string;
}) {
  const t = useTranslations('dashboard');
  const value = typeof metric === 'number' ? metric : metric.value;
  const link = typeof metric === 'number' ? null : metric.link;
  const body = (
    <>
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums',
          value > 0 && tone === 'warning' && 'text-warning',
          value > 0 && tone === 'danger' && 'text-destructive',
        )}
        data-testid={testId === undefined ? undefined : `${testId}-value`}
      >
        {value}
      </span>
      {description === undefined ? null : <span className="text-xs text-muted-foreground">{description}</span>}
    </>
  );
  const className = 'flex min-h-20 flex-col justify-between gap-1 rounded-lg border p-3';
  return link === null ? (
    <div className={className} data-testid={testId}>
      {body}
    </div>
  ) : (
    <Link
      href={linkHref(link)}
      className={cn(className, 'hover:bg-accent focus-visible:bg-accent')}
      data-testid={testId}
      aria-label={t('metricLink', { label, value })}
    >
      {body}
    </Link>
  );
}

export function MetricGrid({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {children}
    </div>
  );
}

export function Freshness({
  generatedAt,
  onRefresh,
}: {
  readonly generatedAt: string;
  readonly onRefresh?: () => void;
}) {
  const t = useTranslations('dashboard');
  const format = useFormatter();
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="dashboard-freshness">
      {t('updatedAt', { time: format.dateTime(new Date(generatedAt), { timeStyle: 'short' }) })}
      {onRefresh === undefined ? null : (
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-accent"
          aria-label={t('refresh')}
        >
          <RefreshCwIcon aria-hidden="true" className="size-4" />
        </button>
      )}
    </p>
  );
}

export function SectionCard({
  title,
  children,
  action,
  testId,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly testId?: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {action}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

export function SectionSkeleton() {
  const t = useTranslations('common');
  return (
    <div role="status" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <span className="sr-only">{t('loading')}</span>
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-20 w-full" />
      ))}
    </div>
  );
}

// ---- Needs Attention ----

const SEVERITY_TONE = { CRITICAL: 'danger', HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const;

function SeverityIcon({ severity }: { readonly severity: AttentionItem['severity'] }) {
  const className = 'mt-0.5 size-4 shrink-0';
  if (severity === 'CRITICAL')
    return <AlertOctagonIcon aria-hidden="true" className={cn(className, 'text-destructive')} />;
  if (severity === 'HIGH')
    return <AlertTriangleIcon aria-hidden="true" className={cn(className, 'text-destructive')} />;
  if (severity === 'MEDIUM') return <CircleAlertIcon aria-hidden="true" className={cn(className, 'text-warning')} />;
  return <InfoIcon aria-hidden="true" className={cn(className, 'text-muted-foreground')} />;
}

function useAttentionText() {
  const t = useTranslations('attention');
  const { date } = useDateFormat();
  return (item: AttentionItem) => {
    const raw = item.params;
    const params = Object.fromEntries(
      Object.entries(raw).map(([key, value]) =>
        key === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
          ? [key, date(value)]
          : [key, value],
      ),
    );
    return { title: t(`types.${item.type}.title`, params), reason: t(`types.${item.type}.reason`, params) };
  };
}

/** The deterministic, rule-based "what needs me now" list (ADR-0023); no ranking of people. */
export function NeedsAttentionCard({ limit = 8 }: { readonly limit?: number }) {
  const t = useTranslations();
  const attention = useNeedsAttention();
  const text = useAttentionText();
  const [expanded, setExpanded] = useState(false);
  const items = attention.data?.items ?? [];
  const shown = expanded ? items : items.slice(0, limit);
  return (
    <SectionCard
      title={t('dashboard.needsAttention')}
      testId="needs-attention"
      action={
        attention.data === undefined ? null : (
          <Badge tone={items.length > 0 ? 'warning' : 'success'}>
            {t('dashboard.attentionCount', { count: attention.data.total })}
          </Badge>
        )
      }
    >
      {attention.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : attention.isError ? (
        <ErrorState
          error={attention.error}
          onRetry={() => {
            void attention.refetch();
          }}
        />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="needs-attention-empty">
          {t('dashboard.attentionEmpty')}
        </p>
      ) : (
        <>
          <ul className="flex flex-col divide-y" aria-label={t('dashboard.needsAttention')}>
            {shown.map((item) => {
              const { title, reason } = text(item);
              return (
                <li key={item.key} data-testid="attention-item" data-type={item.type} data-severity={item.severity}>
                  <Link
                    href={linkHref(item.link)}
                    className="flex min-h-11 items-start gap-3 py-2 hover:bg-accent focus-visible:bg-accent"
                  >
                    <SeverityIcon severity={item.severity} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-center gap-2 font-medium">
                        {title}
                        <Badge tone={SEVERITY_TONE[item.severity]}>{t(`attention.severities.${item.severity}`)}</Badge>
                      </span>
                      <span className="text-sm text-muted-foreground">{reason}</span>
                    </span>
                    <ArrowRightIcon aria-hidden="true" className="mt-1 size-4 shrink-0 rtl:rotate-180" />
                  </Link>
                </li>
              );
            })}
          </ul>
          {items.length > limit ? (
            <button
              type="button"
              className="min-h-11 self-start text-sm underline underline-offset-4"
              onClick={() => {
                setExpanded(!expanded);
              }}
            >
              {expanded ? t('dashboard.showLess') : t('dashboard.showAll', { count: items.length })}
            </button>
          ) : null}
          {attention.data.truncated ? (
            <p className="text-xs text-muted-foreground">{t('dashboard.attentionTruncated')}</p>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}

// ---- Trends ----

const SERIES_CLASS = ['fill-primary', 'fill-muted-foreground/60'] as const;

/** Daily bars from stored history, with the same numbers as text (charts never stand alone). */
export function TrendCard({ metric, title }: { readonly metric: TrendMetric; readonly title: string }) {
  const t = useTranslations('dashboard');
  const { date } = useDateFormat();
  const [range, setRange] = useState<TrendRange>('30d');
  const trend = useTrend(metric, range);
  const selectId = `trend-range-${metric}`;
  const data = trend.data;
  const height = 96;
  const max = Math.max(1, ...(data?.series.flatMap((series) => series.values) ?? [0]));
  const days = data?.dates.length ?? 0;
  const seriesCount = data?.series.length ?? 1;
  const slot = 12;
  const bar = Math.max(2, Math.floor((slot - 2) / seriesCount));
  const totals = data?.series.map((series) => ({
    key: series.key,
    total: series.values.reduce((sum, value) => sum + value, 0),
  }));
  const summary =
    data === undefined
      ? ''
      : t('trendSummary', {
          range: t(`ranges.${range}`),
          values: (totals ?? []).map((item) => `${t(`series.${item.key as 'created'}`)} ${item.total}`).join(', '),
        });
  return (
    <SectionCard
      title={title}
      testId={`trend-${metric}`}
      action={
        <div className="flex items-center gap-2">
          <Label htmlFor={selectId} className="sr-only">
            {t('range')}
          </Label>
          <NativeSelect
            id={selectId}
            value={range}
            onChange={(event) => {
              setRange(oneOf(event.target.value, TREND_RANGES) ?? '30d');
            }}
          >
            {TREND_RANGES.map((value) => (
              <option key={value} value={value}>
                {t(`ranges.${value}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
      }
    >
      {trend.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : trend.isError ? (
        <ErrorState
          error={trend.error}
          onRetry={() => {
            void trend.refetch();
          }}
        />
      ) : data === undefined ? null : (
        <figure className="flex flex-col gap-2">
          <div dir="ltr" className="w-full">
            <svg
              role="img"
              aria-label={summary}
              viewBox={`0 0 ${Math.max(days * slot, slot)} ${height}`}
              preserveAspectRatio="none"
              className="h-28 w-full"
            >
              {data.series.map((series, seriesIndex) =>
                series.values.map((value, dayIndex) => {
                  const h = Math.round((value / max) * (height - 4));
                  return (
                    <rect
                      key={`${series.key}-${String(dayIndex)}`}
                      x={dayIndex * slot + 1 + seriesIndex * bar}
                      y={height - h}
                      width={bar}
                      height={h}
                      className={SERIES_CLASS[seriesIndex % SERIES_CLASS.length]}
                    />
                  );
                }),
              )}
              <line x1="0" x2={days * slot} y1={height - 0.5} y2={height - 0.5} className="stroke-border" />
            </svg>
          </div>
          <figcaption className="flex flex-col gap-1 text-sm">
            <span className="flex flex-wrap gap-3">
              {data.series.map((series, index) => (
                <span key={series.key} className="flex items-center gap-1.5">
                  <svg aria-hidden="true" viewBox="0 0 10 10" className="size-3">
                    <rect width="10" height="10" className={SERIES_CLASS[index % SERIES_CLASS.length]} />
                  </svg>
                  {t(`series.${series.key as 'created'}`)}: {totals?.[index]?.total ?? 0}
                </span>
              ))}
            </span>
            <span className="text-xs text-muted-foreground">
              {data.dates.length > 0
                ? t('trendPeriod', {
                    from: date(data.dates[0] ?? ''),
                    to: date(data.dates.at(-1) ?? ''),
                    zone: data.timeZone,
                  })
                : null}{' '}
              {t(`trendNote.${metric}`)}
            </span>
            {data.truncated ? <span className="text-xs text-warning">{t('trendTruncated')}</span> : null}
            <details className="text-xs">
              <summary className="min-h-11 cursor-pointer content-center">{t('trendValues')}</summary>
              <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                {data.dates.map((day, dayIndex) => (
                  <li key={day} className="flex justify-between gap-2 tabular-nums">
                    <span>{date(day)}</span>
                    <span>
                      {data.series
                        .map((series) => `${t(`series.${series.key as 'created'}`)} ${series.values[dayIndex] ?? 0}`)
                        .join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </figcaption>
        </figure>
      )}
    </SectionCard>
  );
}

// ---- Sections ----

export function SupportSectionView({ section }: { readonly section: SupportSection }) {
  const t = useTranslations('dashboard.support');
  return (
    <MetricGrid label={t('title')}>
      <MetricTile label={t('open')} metric={section.open} testId="metric-support-open" />
      <MetricTile label={t('new')} metric={section.new} testId="metric-support-new" />
      {section.assignedToMe === null ? null : (
        <MetricTile label={t('assignedToMe')} metric={section.assignedToMe} testId="metric-support-assigned" />
      )}
      <MetricTile label={t('critical')} metric={section.critical} tone="danger" testId="metric-support-critical" />
      <MetricTile label={t('slaAtRisk')} metric={section.slaAtRisk} tone="warning" testId="metric-support-at-risk" />
      <MetricTile
        label={t('slaBreached')}
        metric={section.slaBreached}
        tone="danger"
        testId="metric-support-breached"
      />
      <MetricTile label={t('escalated')} metric={section.escalated} tone="warning" testId="metric-support-escalated" />
      <MetricTile
        label={t('waitingForDevelopment')}
        metric={section.waitingForDevelopment}
        testId="metric-support-dev"
      />
      <MetricTile
        label={t('waitingForCustomer')}
        metric={section.waitingForCustomer}
        testId="metric-support-customer"
      />
      <MetricTile label={t('resolvedToday')} metric={section.resolvedToday} testId="metric-support-resolved" />
    </MetricGrid>
  );
}

export function AttendanceTodayView({ section }: { readonly section: AttendanceTodaySection }) {
  const t = useTranslations('dashboard.attendance');
  const { date } = useDateFormat();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">
        {t('forDate', { date: date(section.date), zone: section.timeZone })}
      </p>
      <MetricGrid label={t('title')}>
        <MetricTile label={t('employees')} metric={section.employees} testId="metric-attendance-employees" />
        <MetricTile label={t('present')} metric={section.present} testId="metric-attendance-present" />
        <MetricTile label={t('remote')} metric={section.remote} testId="metric-attendance-remote" />
        <MetricTile label={t('onLeave')} metric={section.onLeave} testId="metric-attendance-leave" />
        <MetricTile label={t('onMission')} metric={section.onMission} testId="metric-attendance-mission" />
        <MetricTile label={t('late')} metric={section.late} tone="warning" testId="metric-attendance-late" />
        <MetricTile label={t('notCheckedIn')} metric={section.notCheckedIn} testId="metric-attendance-not-checked-in" />
        <MetricTile
          label={t('missingCheckout')}
          metric={section.missingCheckout}
          tone="warning"
          testId="metric-attendance-missing-checkout"
        />
        {section.pendingReviews === null ? null : (
          <MetricTile
            label={t('pendingReviews')}
            metric={section.pendingReviews}
            tone="warning"
            testId="metric-attendance-reviews"
          />
        )}
      </MetricGrid>
      {section.truncated ? <p className="text-xs text-warning">{t('truncated')}</p> : null}
    </div>
  );
}

export function ProjectsSectionView({ section }: { readonly section: ProjectsSection }) {
  const t = useTranslations('dashboard.projects');
  return (
    <div className="flex flex-col gap-4">
      <MetricGrid label={t('title')}>
        <MetricTile label={t('active')} metric={section.active} testId="metric-projects-active" />
        <MetricTile label={t('healthy')} metric={section.healthy} testId="metric-projects-healthy" />
        <MetricTile
          label={t('needsAttention')}
          metric={section.needsAttention}
          tone="warning"
          testId="metric-projects-needs-attention"
        />
        <MetricTile label={t('atRisk')} metric={section.atRisk} tone="danger" testId="metric-projects-at-risk" />
        <MetricTile label={t('critical')} metric={section.critical} tone="danger" testId="metric-projects-critical" />
        <MetricTile
          label={t('missingReports')}
          metric={section.missingReportsToday}
          tone="warning"
          description={t('missingReportsHint')}
          testId="metric-projects-missing-reports"
        />
      </MetricGrid>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t('watchlist')}</h3>
        {section.watchlist.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('watchlistEmpty')}</p>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2" aria-label={t('watchlist')}>
            {section.watchlist.map((project) => (
              <li key={project.id} data-testid="watch-project">
                <Link
                  href={linkHref(project.link)}
                  className="flex flex-col gap-1 rounded-lg border p-3 hover:bg-accent focus-visible:bg-accent"
                >
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      <span className="text-muted-foreground">{project.code}</span> {project.name}
                    </span>
                    <ProjectHealthBadge health={project.health} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      t('openTickets', { count: project.openTickets }),
                      t('criticalTickets', { count: project.criticalTickets }),
                      t('slaRiskTickets', { count: project.slaRiskTickets }),
                      project.missingReportsToday === null
                        ? null
                        : t('missingReportsCount', { count: project.missingReportsToday }),
                    ]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IntegrationStatus({
  freshness,
}: {
  readonly freshness: NonNullable<DevelopmentSection['jira']>['freshness'];
}) {
  const t = useTranslations('dashboard.development');
  const { dateTime } = useDateFormat();
  if (freshness.status === 'NOT_CONNECTED') {
    return <Badge>{t('notConnected')}</Badge>;
  }
  return (
    <span
      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
      data-testid="integration-freshness"
    >
      {freshness.status === 'NEEDS_ATTENTION' ? <Badge tone="danger">{t('needsAttention')}</Badge> : null}
      {freshness.stale ? <Badge tone="warning">{t('stale')}</Badge> : null}
      {freshness.lastSyncAt === null ? t('neverSynced') : t('lastSync', { time: dateTime(freshness.lastSyncAt) })}
    </span>
  );
}

/** Jira and GitHub numbers come from the local cache only (no live calls); freshness is always shown. */
export function DevelopmentSectionView({ section }: { readonly section: DevelopmentSection }) {
  const t = useTranslations('dashboard.development');
  if (section.jira === null && section.github === null) {
    return null;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {section.jira === null ? null : (
        <SectionCard
          title={t('jira')}
          testId="dev-jira"
          action={<IntegrationStatus freshness={section.jira.freshness} />}
        >
          <div className="grid grid-cols-3 gap-3">
            <MetricTile label={t('openIssues')} metric={section.jira.open} testId="metric-jira-open" />
            <MetricTile
              label={t('blocked')}
              metric={section.jira.blocked}
              tone="warning"
              testId="metric-jira-blocked"
            />
            <MetricTile label={t('overdue')} metric={section.jira.overdue} tone="danger" testId="metric-jira-overdue" />
          </div>
          <ProjectSignalList
            items={section.jira.projects.map((project) => ({
              ...project,
              text: [
                t('openIssuesCount', { count: project.open }),
                t('blockedCount', { count: project.blocked }),
                t('overdueCount', { count: project.overdue }),
              ].join(' · '),
            }))}
          />
        </SectionCard>
      )}
      {section.github === null ? null : (
        <SectionCard
          title={t('github')}
          testId="dev-github"
          action={<IntegrationStatus freshness={section.github.freshness} />}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricTile label={t('openPulls')} metric={section.github.open} testId="metric-github-open" />
            <MetricTile
              label={t('awaitingReview')}
              metric={section.github.awaitingReview}
              testId="metric-github-review"
            />
            <MetricTile
              label={t('changesRequested')}
              metric={section.github.changesRequested}
              tone="warning"
              testId="metric-github-changes"
            />
            <MetricTile
              label={t('failingChecks')}
              metric={section.github.failingChecks}
              tone="danger"
              testId="metric-github-failing"
            />
          </div>
          <ProjectSignalList
            items={section.github.projects.map((project) => ({
              ...project,
              text: [
                t('openPullsCount', { count: project.open }),
                t('awaitingReviewCount', { count: project.awaitingReview }),
                t('failingChecksCount', { count: project.failingChecks }),
              ].join(' · '),
            }))}
          />
        </SectionCard>
      )}
    </div>
  );
}

function ProjectSignalList({
  items,
}: {
  readonly items: readonly {
    readonly projectId: string;
    readonly code: string;
    readonly name: string;
    readonly text: string;
    readonly link: {
      readonly path: string;
      readonly query: Readonly<Record<string, string>>;
      readonly hash: string | null;
    };
  }[];
}) {
  const t = useTranslations('dashboard.development');
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('noOpenWork')}</p>;
  }
  return (
    <ul className="flex flex-col divide-y" aria-label={t('byProject')}>
      {items.map((item) => (
        <li key={item.projectId}>
          <Link
            href={linkHref(item.link)}
            className="flex min-h-11 flex-col justify-center py-1.5 hover:bg-accent focus-visible:bg-accent"
          >
            <span className="text-sm font-medium">
              <span className="text-muted-foreground">{item.code}</span> {item.name}
            </span>
            <span className="text-xs text-muted-foreground">{item.text}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Personal numbers for the home screen (own requests, tickets, approvals, reports). */
export function MyWorkView({ data }: { readonly data: MeDashboard }) {
  const t = useTranslations('dashboard.me');
  return (
    <MetricGrid label={t('title')}>
      {data.approvals === null ? null : (
        <>
          <MetricTile label={t('approvalsWaiting')} metric={data.approvals.waiting} testId="metric-approvals-waiting" />
          <MetricTile
            label={t('approvalsOverdue')}
            metric={data.approvals.overdue}
            tone="danger"
            testId="metric-approvals-overdue"
          />
        </>
      )}
      <MetricTile label={t('myPendingRequests')} metric={data.myPendingRequests} testId="metric-my-requests" />
      <MetricTile label={t('myOpenTickets')} metric={data.myOpenTickets} testId="metric-my-tickets" />
      {data.assignedTickets === null ? null : (
        <MetricTile label={t('assignedTickets')} metric={data.assignedTickets} testId="metric-assigned-tickets" />
      )}
    </MetricGrid>
  );
}

export function DashboardError({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return <ErrorState error={error} onRetry={onRetry} />;
}

export function NoData({ message }: { readonly message: string }) {
  return <EmptyState message={message} />;
}
