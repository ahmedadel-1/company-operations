import {
  BellIcon,
  BellRingIcon,
  BriefcaseIcon,
  FileSignatureIcon,
  FolderLockIcon,
  GavelIcon,
  LandmarkIcon,
  Building2Icon,
  CalendarCheckIcon,
  ChartColumnIcon,
  GaugeIcon,
  RocketIcon,
  UsersRoundIcon,
  ClockIcon,
  ClipboardListIcon,
  FolderKanbanIcon,
  GitPullRequestIcon,
  GitBranchIcon,
  InboxIcon,
  FileTextIcon,
  HandshakeIcon,
  HomeIcon,
  KeyRoundIcon,
  LifeBuoyIcon,
  ListChecksIcon,
  PlugZapIcon,
  MapPinIcon,
  NetworkIcon,
  ScrollTextIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  TimerIcon,
  UsersIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { PermissionKey } from '@company-ops/shared';

export type NavLabel =
  | 'home'
  | 'projects'
  | 'dailyReports'
  | 'customers'
  | 'workLocations'
  | 'employees'
  | 'departments'
  | 'teams'
  | 'organization'
  | 'roles'
  | 'jobTitles'
  | 'audit'
  | 'systemJobs'
  | 'notifications'
  | 'support'
  | 'supportConfig'
  | 'jiraIntegration'
  | 'githubIntegration'
  | 'requests'
  | 'approvals'
  | 'requestTypes'
  | 'attendance'
  | 'teamAttendance'
  | 'attendanceConfig'
  | 'supportDashboard'
  | 'projectsDashboard'
  | 'teamDashboard'
  | 'executiveDashboard'
  | 'tenders'
  | 'contracts'
  | 'documents'
  | 'commercialDashboard'
  | 'commercialSettings'
  | 'setup';

export interface NavItem {
  readonly href: string;
  readonly label: NavLabel;
  readonly icon: LucideIcon;
  /** Hidden unless the member holds this permission (UX only; the API enforces). */
  readonly permission?: PermissionKey;
  /** Hidden unless the member holds this permission beyond their own records (scope other than SELF). */
  readonly beyondSelf?: PermissionKey;
  /** Alternatively: shown when the member holds any of these permissions. */
  readonly anyOf?: readonly PermissionKey[];
  /** Active only on this exact path (a sibling item owns the sub-paths). */
  readonly exact?: boolean;
}

export interface NavGroup {
  readonly label: 'groupWork' | 'groupInsights' | 'groupPeople' | 'groupAdmin' | null;
  readonly items: readonly NavItem[];
}

/** Navigation of the delivered modules (UI_UX.md §1.1). Later modules add their items when they ship. */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: null,
    items: [
      { href: '/', label: 'home', icon: HomeIcon },
      { href: '/notifications', label: 'notifications', icon: BellIcon },
    ],
  },
  {
    label: 'groupWork',
    items: [
      { href: '/requests', label: 'requests', icon: FileTextIcon, anyOf: ['request.create', 'request.view'] },
      { href: '/approvals', label: 'approvals', icon: InboxIcon, permission: 'request.approve' },
      { href: '/attendance', label: 'attendance', icon: ClockIcon, permission: 'attendance.self', exact: true },
      { href: '/attendance/team', label: 'teamAttendance', icon: CalendarCheckIcon, permission: 'attendance.team' },
      { href: '/support', label: 'support', icon: LifeBuoyIcon, anyOf: ['support.view', 'support.create'] },
      { href: '/projects', label: 'projects', icon: FolderKanbanIcon, permission: 'project.view' },
      {
        href: '/daily-reports',
        label: 'dailyReports',
        icon: ClipboardListIcon,
        anyOf: ['daily_report.submit', 'daily_report.view'],
      },
      {
        href: '/customers',
        label: 'customers',
        icon: HandshakeIcon,
        anyOf: ['project.create', 'project.manage'],
      },
      { href: '/tenders', label: 'tenders', icon: GavelIcon, anyOf: ['tender.view', 'tender.create'] },
      { href: '/contracts', label: 'contracts', icon: FileSignatureIcon, permission: 'contract.view' },
      { href: '/documents', label: 'documents', icon: FolderLockIcon, permission: 'corporate_document.view' },
    ],
  },
  {
    label: 'groupInsights',
    items: [
      { href: '/dashboards/support', label: 'supportDashboard', icon: LifeBuoyIcon, beyondSelf: 'support.view' },
      {
        href: '/dashboards/projects',
        label: 'projectsDashboard',
        icon: ChartColumnIcon,
        permission: 'dashboard.project',
      },
      { href: '/dashboards/team', label: 'teamDashboard', icon: UsersRoundIcon, permission: 'attendance.team' },
      {
        href: '/dashboards/executive',
        label: 'executiveDashboard',
        icon: GaugeIcon,
        permission: 'dashboard.executive',
      },
      {
        href: '/dashboards/commercial',
        label: 'commercialDashboard',
        icon: LandmarkIcon,
        anyOf: ['tender.view', 'contract.view', 'corporate_document.view'],
      },
    ],
  },
  {
    label: 'groupPeople',
    items: [
      { href: '/people', label: 'employees', icon: UsersIcon, permission: 'employee.view' },
      { href: '/departments', label: 'departments', icon: Building2Icon, permission: 'employee.view' },
      { href: '/teams', label: 'teams', icon: NetworkIcon, permission: 'employee.view' },
    ],
  },
  {
    label: 'groupAdmin',
    items: [
      { href: '/admin/setup', label: 'setup', icon: RocketIcon, permission: 'org.settings.manage' },
      { href: '/admin/organization', label: 'organization', icon: SettingsIcon, permission: 'org.settings.manage' },
      { href: '/admin/roles', label: 'roles', icon: KeyRoundIcon, permission: 'role.manage' },
      { href: '/admin/job-titles', label: 'jobTitles', icon: BriefcaseIcon, permission: 'department.manage' },
      { href: '/admin/work-locations', label: 'workLocations', icon: MapPinIcon, permission: 'attendance.config' },
      { href: '/admin/request-types', label: 'requestTypes', icon: GitBranchIcon, permission: 'request.admin' },
      {
        href: '/admin/attendance',
        label: 'attendanceConfig',
        icon: SlidersHorizontalIcon,
        anyOf: ['attendance.config', 'org.settings.manage'],
      },
      { href: '/admin/support', label: 'supportConfig', icon: TimerIcon, permission: 'support.config' },
      {
        href: '/admin/commercial',
        label: 'commercialSettings',
        icon: BellRingIcon,
        permission: 'org.settings.manage',
      },
      {
        href: '/admin/integrations/jira',
        label: 'jiraIntegration',
        icon: PlugZapIcon,
        permission: 'integration.manage',
      },
      {
        href: '/admin/integrations/github',
        label: 'githubIntegration',
        icon: GitPullRequestIcon,
        permission: 'integration.manage',
      },
      { href: '/admin/audit', label: 'audit', icon: ScrollTextIcon, permission: 'audit.view' },
      { href: '/admin/jobs', label: 'systemJobs', icon: ListChecksIcon, permission: 'org.settings.manage' },
    ],
  },
];

export function isPermitted(
  item: NavItem,
  can: (permission: PermissionKey) => boolean,
  beyondSelf: (permission: PermissionKey) => boolean = () => false,
): boolean {
  if (item.beyondSelf !== undefined) {
    return beyondSelf(item.beyondSelf);
  }
  if (item.permission !== undefined) {
    return can(item.permission);
  }
  if (item.anyOf !== undefined) {
    return item.anyOf.some(can);
  }
  return true;
}

export function isActive(pathname: string, href: string, exact = false): boolean {
  return href === '/' || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}
