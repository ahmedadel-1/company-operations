import type {
  EmploymentStatus,
  MemberStatus,
  Prisma,
  SlaState,
  TicketImpact,
  TicketPriority,
  TicketSeverity,
  TicketSource,
  TicketStatus,
} from '@company-ops/db';

import { ticketKey } from './ticket-access.js';

/** A member shown on a ticket. `active` = can still sign in and is not terminated. */
export interface TicketPersonRef {
  readonly memberId: string;
  readonly name: string;
  readonly active: boolean;
}

export const memberRefSelect = {
  id: true,
  status: true,
  user: { select: { displayName: true } },
  profile: { select: { fullName: true, employmentStatus: true } },
} satisfies Prisma.OrganizationMemberSelect;

interface MemberRefRow {
  readonly id: string;
  readonly status: MemberStatus;
  readonly user: { readonly displayName: string } | null;
  readonly profile: { readonly fullName: string; readonly employmentStatus: EmploymentStatus } | null;
}

export function toPersonRef(row: MemberRefRow): TicketPersonRef {
  return {
    memberId: row.id,
    name: row.profile?.fullName ?? row.user?.displayName ?? '—',
    active: row.status === 'ACTIVE' && row.profile?.employmentStatus !== 'TERMINATED',
  };
}

export interface TicketSlaView {
  readonly policy: { readonly id: string; readonly name: string };
  readonly firstResponseDueAt: string | null;
  readonly resolutionDueAt: string | null;
  readonly firstRespondedAt: string | null;
  readonly firstResponseState: SlaState | null;
  readonly resolutionState: SlaState | null;
  readonly paused: boolean;
}

export interface TicketSummaryView {
  readonly id: string;
  readonly number: number;
  readonly key: string;
  readonly title: string;
  readonly status: TicketStatus;
  readonly severity: TicketSeverity;
  readonly priority: TicketPriority;
  readonly impact: TicketImpact;
  readonly source: TicketSource;
  readonly project: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly category: { readonly id: string; readonly name: string } | null;
  readonly assignedTeam: { readonly id: string; readonly name: string } | null;
  readonly assignee: TicketPersonRef | null;
  readonly reporter: TicketPersonRef;
  readonly escalationLevel: number;
  readonly sla: TicketSlaView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const ticketSummarySelect = {
  id: true,
  number: true,
  title: true,
  status: true,
  severity: true,
  priority: true,
  impact: true,
  source: true,
  escalationLevel: true,
  createdAt: true,
  updatedAt: true,
  firstResponseDueAt: true,
  resolutionDueAt: true,
  firstRespondedAt: true,
  firstResponseSlaState: true,
  resolutionSlaState: true,
  slaPausedSince: true,
  project: { select: { id: true, code: true, name: true } },
  category: { select: { id: true, name: true } },
  assignedTeam: { select: { id: true, name: true } },
  assignee: { select: memberRefSelect },
  reporter: { select: memberRefSelect },
  slaPolicy: { select: { id: true, name: true } },
} satisfies Prisma.SupportTicketSelect;

export type TicketSummaryRow = Prisma.SupportTicketGetPayload<{ select: typeof ticketSummarySelect }>;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function toTicketSummary(row: TicketSummaryRow): TicketSummaryView {
  return {
    id: row.id,
    number: row.number,
    key: ticketKey(row.number),
    title: row.title,
    status: row.status,
    severity: row.severity,
    priority: row.priority,
    impact: row.impact,
    source: row.source,
    project: row.project,
    category: row.category,
    assignedTeam: row.assignedTeam,
    assignee: row.assignee === null ? null : toPersonRef(row.assignee),
    reporter: toPersonRef(row.reporter),
    escalationLevel: row.escalationLevel,
    sla:
      row.slaPolicy === null
        ? null
        : {
            policy: row.slaPolicy,
            firstResponseDueAt: iso(row.firstResponseDueAt),
            resolutionDueAt: iso(row.resolutionDueAt),
            firstRespondedAt: iso(row.firstRespondedAt),
            firstResponseState: row.firstResponseSlaState,
            resolutionState: row.resolutionSlaState,
            paused: row.slaPausedSince !== null,
          },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const ticketDetailSelect = {
  ...ticketSummarySelect,
  description: true,
  component: { select: { id: true, name: true } },
  resolutionNote: true,
  resolvedAt: true,
  verifiedAt: true,
  closedAt: true,
  cancelledAt: true,
  version: true,
  _count: { select: { watchers: true } },
} satisfies Prisma.SupportTicketSelect;

export type TicketDetailRow = Prisma.SupportTicketGetPayload<{ select: typeof ticketDetailSelect }>;

/** What the caller may do on the ticket (UX hints; every action is re-checked by the server). */
export interface TicketAccess {
  readonly canEdit: boolean;
  readonly canClassify: boolean;
  readonly canAssign: boolean;
  readonly canComment: boolean;
  readonly canAddInternalNote: boolean;
  readonly canViewInternalNotes: boolean;
  readonly canWatch: boolean;
  readonly canManageWatchers: boolean;
  readonly canAttach: boolean;
  readonly transitions: readonly { readonly to: TicketStatus; readonly noteRequired: boolean }[];
}

export interface TicketView extends TicketSummaryView {
  readonly description: string;
  readonly component: { readonly id: string; readonly name: string } | null;
  readonly resolutionNote: string | null;
  readonly resolvedAt: string | null;
  readonly verifiedAt: string | null;
  readonly closedAt: string | null;
  readonly cancelledAt: string | null;
  readonly version: number;
  readonly watching: boolean;
  readonly watcherCount: number;
  readonly access: TicketAccess;
}

export function toTicketView(row: TicketDetailRow, watching: boolean, access: TicketAccess): TicketView {
  return {
    ...toTicketSummary(row),
    description: row.description,
    component: row.component,
    resolutionNote: row.resolutionNote,
    resolvedAt: iso(row.resolvedAt),
    verifiedAt: iso(row.verifiedAt),
    closedAt: iso(row.closedAt),
    cancelledAt: iso(row.cancelledAt),
    version: row.version,
    watching,
    watcherCount: row._count.watchers,
    access,
  };
}
