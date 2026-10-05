'use client';

import {
  BarChart3Icon,
  BellIcon,
  ClipboardListIcon,
  ClockIcon,
  FilePlusIcon,
  FolderKanbanIcon,
  LifeBuoyIcon,
  ListChecksIcon,
  SearchIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Badge } from '@company-ops/ui/components/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@company-ops/ui/components/card';
import { Skeleton } from '@company-ops/ui/components/skeleton';

import { StatusBadge } from '../../components/attendance';
import {
  Freshness,
  MyWorkView,
  NeedsAttentionCard,
  SectionCard,
  SectionSkeleton,
  useDashboardAccess,
} from '../../components/dashboard';
import { ProjectHealthBadge } from '../../components/projects';
import { openSearch } from '../../components/search-dialog';
import { ErrorState, PageHeader } from '../../components/states';
import { useAttendanceToday } from '../../lib/attendance';
import { useMeDashboard, useSetupChecklist } from '../../lib/dashboard';
import { useDateFormat } from '../../lib/format';
import { linkHref } from '../../lib/link-params';
import { useCan, useCanOrgWide, useSession } from '../../lib/session';

/**
 * Operational home (UI_UX.md §3, ADR-0023): what needs the member now, their own numbers and quick
 * actions. Stacked cards on phones (no tables, no horizontal scroll); compact tiles on desktop.
 */
export default function HomePage() {
  const t = useTranslations('home');
  const me = useSession();
  const can = useCan();
  const orgWide = useCanOrgWide();
  const dashboard = useMeDashboard();

  return (
    <>
      <PageHeader
        title={t('greeting', { name: me.user.displayName })}
        description={t('intro', { organization: me.activeOrganization.name })}
        actions={
          dashboard.data === undefined ? undefined : (
            <Freshness
              generatedAt={dashboard.data.generatedAt}
              onRefresh={() => {
                void dashboard.refetch();
              }}
            />
          )
        }
      />
      <div className="flex flex-col gap-4">
        <QuickActions />
        {orgWide('org.settings.manage') ? <SetupProgress /> : null}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-4 lg:col-span-2">
            <NeedsAttentionCard />
            <SectionCard title={t('myWork')} testId="home-my-work">
              {dashboard.isPending ? (
                <SectionSkeleton />
              ) : dashboard.isError ? (
                <ErrorState
                  error={dashboard.error}
                  onRetry={() => {
                    void dashboard.refetch();
                  }}
                />
              ) : (
                <MyWorkView data={dashboard.data} />
              )}
            </SectionCard>
          </div>
          <div className="flex flex-col gap-4">
            {can('attendance.self') ? <AttendanceTodayCard /> : null}
            <DailyReportsDueCard />
            <MyProjectsCard />
            <NotificationsCard />
            <InsightsCard />
          </div>
        </div>
      </div>
    </>
  );
}

function QuickAction({
  href,
  icon,
  label,
  onClick,
}: {
  readonly href?: string;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onClick?: () => void;
}) {
  const className =
    'flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:bg-accent';
  return (
    <li>
      {href === undefined ? (
        <button type="button" className={`${className} w-full`} onClick={onClick}>
          {icon}
          {label}
        </button>
      ) : (
        <Link href={href} className={className}>
          {icon}
          {label}
        </Link>
      )}
    </li>
  );
}

function QuickActions() {
  const t = useTranslations('home');
  const can = useCan();
  const attendance = useAttendanceToday(can('attendance.self'));
  const next = attendance.data?.nextAction;
  return (
    <nav aria-label={t('quickActions')}>
      <ul className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap" data-testid="quick-actions">
        {can('attendance.self') ? (
          <QuickAction
            href="/attendance"
            icon={<ClockIcon aria-hidden="true" className="size-4" />}
            label={
              next === 'CHECK_IN'
                ? t('attendanceCheckIn')
                : next === 'CHECK_OUT'
                  ? t('attendanceCheckOut')
                  : t('attendanceOpen')
            }
          />
        ) : null}
        {can('request.create') ? (
          <QuickAction
            href="/requests/new"
            icon={<FilePlusIcon aria-hidden="true" className="size-4" />}
            label={t('newRequest')}
          />
        ) : null}
        {can('support.create') ? (
          <QuickAction
            href="/support/new"
            icon={<LifeBuoyIcon aria-hidden="true" className="size-4" />}
            label={t('reportIssue')}
          />
        ) : null}
        {can('daily_report.submit') ? (
          <QuickAction
            href="/daily-reports"
            icon={<ClipboardListIcon aria-hidden="true" className="size-4" />}
            label={t('dailyReports')}
          />
        ) : null}
        <QuickAction
          icon={<SearchIcon aria-hidden="true" className="size-4" />}
          label={t('search')}
          onClick={openSearch}
        />
      </ul>
    </nav>
  );
}

function AttendanceTodayCard() {
  const t = useTranslations('home');
  const attendance = useAttendanceToday(true);
  const record = attendance.data?.record ?? null;
  return (
    <Card data-testid="home-attendance">
      <CardHeader>
        <CardTitle>{t('attendanceToday')}</CardTitle>
        <ClockIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-2">
        {attendance.isPending ? (
          <Skeleton className="h-6 w-40" />
        ) : (
          <>
            {record === null ? <span>{t('attendanceNotRecorded')}</span> : <StatusBadge status={record.status} />}
            <Link
              href="/attendance"
              className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline"
            >
              {attendance.data?.nextAction === 'CHECK_IN'
                ? t('attendanceCheckIn')
                : attendance.data?.nextAction === 'CHECK_OUT'
                  ? t('attendanceCheckOut')
                  : t('attendanceOpen')}
            </Link>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DailyReportsDueCard() {
  const t = useTranslations('home');
  const { date } = useDateFormat();
  const dashboard = useMeDashboard();
  const due = dashboard.data?.dailyReportsDue ?? [];
  if (due.length === 0) return null;
  return (
    <SectionCard title={t('reportsDue')} testId="home-reports-due">
      <ul className="flex flex-col divide-y">
        {due.map((report) => (
          <li key={report.projectId}>
            <Link
              href={linkHref(report.link)}
              className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1.5 hover:bg-accent"
            >
              <span className="text-sm font-medium">
                <span className="text-muted-foreground">{report.code}</span> {report.name}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {date(report.date)}
                {report.overdue ? (
                  <Badge tone="danger">{t('reportOverdue')}</Badge>
                ) : (
                  <Badge>{t('reportDueToday')}</Badge>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function MyProjectsCard() {
  const t = useTranslations('home');
  const dashboard = useMeDashboard();
  const projects = dashboard.data?.projects ?? [];
  if (projects.length === 0) return null;
  return (
    <SectionCard
      title={t('myProjects')}
      testId="home-projects"
      action={<FolderKanbanIcon aria-hidden="true" className="size-4 text-muted-foreground" />}
    >
      <ul className="flex flex-col divide-y">
        {projects.map((project) => (
          <li key={project.id}>
            <Link
              href={linkHref(project.link)}
              className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1.5 hover:bg-accent"
            >
              <span className="text-sm font-medium">
                <span className="text-muted-foreground">{project.code}</span> {project.name}
              </span>
              <ProjectHealthBadge health={project.health} />
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function NotificationsCard() {
  const t = useTranslations('home');
  const dashboard = useMeDashboard();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('openNotifications')}</CardTitle>
        <BellIcon aria-hidden="true" className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        {dashboard.isPending ? (
          <Skeleton className="h-6 w-40" />
        ) : (
          <Link
            href="/notifications"
            className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline"
          >
            {t('unread', { count: dashboard.data?.unreadNotifications ?? 0 })}
          </Link>
        )}
      </CardContent>
    </Card>
  );
}

/** Links to the role dashboards the member can open (UX only; each endpoint re-checks). */
function InsightsCard() {
  const t = useTranslations();
  const access = useDashboardAccess();
  const links = [
    access.support ? { href: '/dashboards/support', label: t('nav.supportDashboard') } : null,
    access.projects ? { href: '/dashboards/projects', label: t('nav.projectsDashboard') } : null,
    access.team ? { href: '/dashboards/team', label: t('nav.teamDashboard') } : null,
    access.executive ? { href: '/dashboards/executive', label: t('nav.executiveDashboard') } : null,
  ].filter((link): link is { href: string; label: string } => link !== null);
  if (links.length === 0) return null;
  return (
    <SectionCard
      title={t('nav.groupInsights')}
      testId="home-insights"
      action={<BarChart3Icon aria-hidden="true" className="size-4 text-muted-foreground" />}
    >
      <ul className="flex flex-col gap-1">
        {links.map((link) => (
          <li key={link.href}>
            <Link
              href={link.href}
              className="inline-flex min-h-11 items-center underline underline-offset-4 hover:no-underline"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function SetupProgress() {
  const t = useTranslations('setup');
  const checklist = useSetupChecklist();
  const data = checklist.data;
  if (data === undefined) return null;
  const requiredDone = data.items.filter((item) => !item.optional && item.done).length;
  if (requiredDone >= data.required) return null;
  return (
    <Card data-testid="home-setup">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm">
          <ListChecksIcon aria-hidden="true" className="size-4" />
          {t('progress', { done: requiredDone, total: data.required })}
        </span>
        <Link href="/admin/setup" className="inline-flex min-h-11 items-center text-sm underline underline-offset-4">
          {t('continue')}
        </Link>
      </CardContent>
    </Card>
  );
}
