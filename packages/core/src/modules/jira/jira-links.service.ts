import { createHash } from 'node:crypto';

import type { JiraStatusCategory, Prisma, TicketJiraLinkSource, TicketJiraLinkType } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { recordProjectActivity } from '../projects/project-activity.js';
import {
  assertTicketPermission,
  assertTicketUnlocked,
  holdsOnTicket,
  loadVisibleTicket,
  ticketKey,
} from '../support/ticket-access.js';
import type { LoadedTicket } from '../support/ticket-access.js';
import { recordTicketEvent } from '../support/ticket-history.js';
import { announceTicketChange, notifyTicketAudience, watcherMemberIds } from '../support/ticket-notify.js';
import type { JiraClient } from './jira-client.js';
import {
  JiraApiError,
  JiraCreateOutcomeUnknownError,
  JiraNotConfiguredError,
  JiraNotConnectedError,
  JiraReauthRequiredError,
  toJiraDomainError,
} from './jira-errors.js';
import { applySnapshot, loadPlacement } from './jira-issue-store.js';
import { linkSearchJql } from './jira-jql.js';
import { issueBrowseUrl, toSnapshot } from './jira-mapper.js';
import type { JiraIssueSnapshot } from './jira-mapper.js';
import type { JiraRuntime } from './jira-runtime.js';

export interface JiraIssueView {
  readonly id: string;
  readonly jiraIssueId: string;
  readonly key: string;
  readonly summary: string;
  readonly issueType: string;
  readonly statusName: string;
  readonly statusCategory: JiraStatusCategory;
  readonly priorityName: string | null;
  readonly assigneeDisplayName: string | null;
  readonly dueDate: string | null;
  readonly isBlocked: boolean;
  readonly url: string;
  readonly jiraUpdatedAt: string;
  readonly lastSyncedAt: string;
  /** Deleted in Jira or no longer visible to the connection. */
  readonly removedInJira: boolean;
}

export interface TicketJiraLinkView {
  readonly id: string;
  readonly linkType: TicketJiraLinkType;
  readonly createdVia: TicketJiraLinkSource;
  readonly createdAt: string;
  readonly createdBy: { readonly memberId: string; readonly fullName: string | null } | null;
  readonly issue: JiraIssueView;
}

export interface TicketJiraPanel {
  /** False when the caller may not see Jira information on this ticket (no `jira.view`). */
  readonly visible: boolean;
  /** The ticket's project has a mapped Jira project on a usable connection. */
  readonly available: boolean;
  readonly canLink: boolean;
  readonly canCreate: boolean;
  readonly connectionStatus: 'ACTIVE' | 'NEEDS_REAUTH' | 'ERROR' | null;
  readonly mappings: readonly {
    readonly id: string;
    readonly jiraProjectKey: string;
    readonly jiraProjectName: string;
  }[];
  readonly links: readonly TicketJiraLinkView[];
}

export interface JiraSearchResult extends JiraIssueView {
  readonly linked: boolean;
}

export const issueViewSelect = {
  id: true,
  jiraIssueId: true,
  issueKey: true,
  summary: true,
  issueType: true,
  statusName: true,
  statusCategory: true,
  priorityName: true,
  assigneeDisplayName: true,
  dueDate: true,
  isBlocked: true,
  url: true,
  jiraUpdatedAt: true,
  lastSyncedAt: true,
  deletedInJiraAt: true,
} satisfies Prisma.JiraIssueSelect;

export type IssueViewRow = Prisma.JiraIssueGetPayload<{ select: typeof issueViewSelect }>;

export function toIssueView(row: IssueViewRow): JiraIssueView {
  return {
    id: row.id,
    jiraIssueId: row.jiraIssueId,
    key: row.issueKey,
    summary: row.summary,
    issueType: row.issueType,
    statusName: row.statusName,
    statusCategory: row.statusCategory,
    priorityName: row.priorityName,
    assigneeDisplayName: row.assigneeDisplayName,
    dueDate: row.dueDate?.toISOString().slice(0, 10) ?? null,
    isBlocked: row.isBlocked,
    url: row.url,
    jiraUpdatedAt: row.jiraUpdatedAt.toISOString(),
    lastSyncedAt: row.lastSyncedAt.toISOString(),
    removedInJira: row.deletedInJiraAt !== null,
  };
}

const linkSelect = {
  id: true,
  linkType: true,
  createdVia: true,
  createdAt: true,
  createdBy: { select: { id: true, profile: { select: { fullName: true } } } },
  issue: { select: issueViewSelect },
} satisfies Prisma.SupportTicketJiraLinkSelect;

type LinkRow = Prisma.SupportTicketJiraLinkGetPayload<{ select: typeof linkSelect }>;

function toLinkView(row: LinkRow): TicketJiraLinkView {
  return {
    id: row.id,
    linkType: row.linkType,
    createdVia: row.createdVia,
    createdAt: row.createdAt.toISOString(),
    createdBy:
      row.createdBy === null ? null : { memberId: row.createdBy.id, fullName: row.createdBy.profile?.fullName ?? null },
    issue: toIssueView(row.issue),
  };
}

const MAX_LINKS = 50;
const SEARCH_LIMIT = 20;
const PENDING_STALE_MS = 2 * 60 * 1000;

interface TicketMapping {
  readonly id: string;
  readonly connectionId: string;
  readonly jiraProjectId: string;
  readonly jiraProjectKey: string;
  readonly jiraProjectName: string;
  readonly connection: {
    readonly cloudId: string;
    readonly siteUrl: string;
    readonly status: 'ACTIVE' | 'NEEDS_REAUTH' | 'ERROR' | 'DISCONNECTED';
  };
}

export interface CreateIssueInput {
  readonly mappingId: string;
  readonly issueTypeId: string;
  readonly summary: string;
  readonly description: string;
  readonly linkType: TicketJiraLinkType;
}

/**
 * Atlassian Document Format for the issue description: the text the user confirmed (paragraphs and
 * line breaks preserved), then a backlink to the ticket. Never internal notes or attachments.
 */
export function issueDescriptionAdf(
  text: string,
  backlink: { ticketKey: string; url: string },
): Prisma.InputJsonObject {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => ({
      type: 'paragraph',
      content: block
        .split('\n')
        .flatMap((line, index) => [
          ...(index > 0 ? [{ type: 'hardBreak' }] : []),
          ...(line.length > 0 ? [{ type: 'text', text: line }] : []),
        ]),
    }));
  return {
    type: 'doc',
    version: 1,
    content: [
      ...paragraphs,
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: `Support ticket ${backlink.ticketKey}: ` },
          { type: 'text', text: backlink.url, marks: [{ type: 'link', attrs: { href: backlink.url } }] },
        ],
      },
    ],
  };
}

/**
 * Support ticket ↔ Jira issue links (INTEGRATIONS §1.9.5). Viewing links needs `jira.view` on the
 * ticket (reporters without it see nothing); linking needs `jira.link`, creating needs
 * `jira.create_issue`, both on an unlocked ticket. Only issues of Jira projects mapped to the
 * ticket's project can be linked or created. Linking never changes the ticket's or the issue's
 * status. Creating an issue is idempotent per ticket and client key: the reservation row means a
 * double submit or retry never creates two issues, and an interrupted attempt is reported as
 * "outcome unknown" instead of being blindly repeated.
 */
export class JiraLinksService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: JiraRuntime | null,
    private readonly appPublicUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async panel(action: ActionContext, ticketId: string): Promise<TicketJiraPanel> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    if (!holdsOnTicket(action.principal, 'jira.view', ticket)) {
      return {
        visible: false,
        available: false,
        canLink: false,
        canCreate: false,
        connectionStatus: null,
        mappings: [],
        links: [],
      };
    }
    const [mappings, links] = await Promise.all([
      this.ticketMappings(organizationId, ticket),
      this.db.supportTicketJiraLink.findMany({
        where: { organizationId, ticketId: ticket.row.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_LINKS,
        select: linkSelect,
      }),
    ]);
    const status = mappings[0]?.connection.status ?? null;
    const usable = this.runtime !== null && mappings.length > 0 && status !== 'NEEDS_REAUTH';
    return {
      visible: true,
      available: usable,
      canLink: usable && holdsOnTicket(action.principal, 'jira.link', ticket),
      canCreate: usable && holdsOnTicket(action.principal, 'jira.create_issue', ticket),
      connectionStatus: status === 'DISCONNECTED' ? null : status,
      mappings: mappings.map((m) => ({
        id: m.id,
        jiraProjectKey: m.jiraProjectKey,
        jiraProjectName: m.jiraProjectName,
      })),
      links: links.map(toLinkView),
    };
  }

  /** Issues in the mapped projects: the local cache, or live Jira (results are cached first). */
  async search(
    action: ActionContext,
    ticketId: string,
    input: { q: string; source: 'cache' | 'jira' },
  ): Promise<JiraSearchResult[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    assertTicketPermission(action, 'jira.link', ticket);
    const mappings = await this.requireMappings(organizationId, ticket);
    const q = input.q.trim().slice(0, 100);
    let rows: IssueViewRow[];
    if (input.source === 'jira') {
      const client = this.client(organizationId, mappings);
      let page;
      try {
        page = await client.searchJql(linkSearchJql([...new Set(mappings.map((m) => m.jiraProjectId))], q), {
          maxResults: SEARCH_LIMIT,
        });
      } catch (error) {
        throw error instanceof JiraApiError ? toJiraDomainError(error) : error;
      }
      const placement = await loadPlacement(this.db, organizationId, mappings[0]?.connectionId ?? '');
      const siteUrl = mappings[0]?.connection.siteUrl ?? '';
      const ids: string[] = [];
      for (const issue of page.issues) {
        const snapshot = toSnapshot(issue, siteUrl);
        if (snapshot !== null) {
          await applySnapshot(this.db, placement, snapshot, { now: this.now() });
          ids.push(snapshot.jiraIssueId);
        }
      }
      const found = await this.db.jiraIssue.findMany({
        where: {
          organizationId,
          connectionId: mappings[0]?.connectionId ?? '',
          jiraIssueId: { in: ids },
          mappingId: { in: mappings.map((m) => m.id) },
        },
        select: issueViewSelect,
      });
      const order = new Map(ids.map((id, index) => [id, index]));
      rows = found.sort((a, b) => (order.get(a.jiraIssueId) ?? 0) - (order.get(b.jiraIssueId) ?? 0));
    } else {
      rows = await this.db.jiraIssue.findMany({
        where: {
          organizationId,
          mappingId: { in: mappings.map((m) => m.id) },
          deletedInJiraAt: null,
          ...(q === ''
            ? {}
            : { OR: [{ issueKey: q.toUpperCase() }, { summary: { contains: q, mode: 'insensitive' } }] }),
        },
        orderBy: [{ jiraUpdatedAt: 'desc' }, { id: 'desc' }],
        take: SEARCH_LIMIT,
        select: issueViewSelect,
      });
    }
    const linked = new Set(
      (
        await this.db.supportTicketJiraLink.findMany({
          where: { organizationId, ticketId: ticket.row.id, issueId: { in: rows.map((row) => row.id) } },
          select: { issueId: true },
        })
      ).map((row) => row.issueId),
    );
    return rows.map((row) => ({ ...toIssueView(row), linked: linked.has(row.id) }));
  }

  async link(
    action: ActionContext,
    ticketId: string,
    input: { issueId: string; linkType: TicketJiraLinkType },
  ): Promise<TicketJiraLinkView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const linkId = await this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      assertTicketPermission(action, 'jira.link', ticket);
      assertTicketUnlocked(ticket);
      const mappings = await this.requireMappings(organizationId, ticket, tx);
      const issue = await tx.jiraIssue.findFirst({
        where: {
          organizationId,
          id: input.issueId,
          mappingId: { in: mappings.map((m) => m.id) },
          deletedInJiraAt: null,
        },
        select: { id: true, issueKey: true, jiraIssueId: true },
      });
      if (issue === null) {
        throw new NotFoundError('Jira issue');
      }
      const count = await tx.supportTicketJiraLink.count({ where: { organizationId, ticketId: ticket.row.id } });
      if (count >= MAX_LINKS) {
        throw new InvalidInputError('issueId', 'This ticket has reached the maximum number of Jira links.');
      }
      const id = await this.insertLink(
        tx,
        organizationId,
        ticket,
        issue.id,
        input.linkType,
        'LINKED_EXISTING',
        action.principal.memberId,
      );
      if (id === null) {
        throw new ConflictError('This Jira issue is already linked to the ticket.');
      }
      await recordTicketEvent(tx, organizationId, ticket.row.id, {
        type: 'JIRA_LINKED',
        actorMemberId: action.principal.memberId,
        to: { issueKey: issue.issueKey, linkType: input.linkType },
        metadata: { issueId: issue.id, jiraIssueId: issue.jiraIssueId },
      });
      await recordAudit(tx, organizationId, {
        action: 'jira.link.created',
        entityType: 'support_ticket',
        entityId: ticket.row.id,
        actor: userActor(action),
        metadata: { linkId: id, issueKey: issue.issueKey, linkType: input.linkType },
        context: action.request,
      });
      await announceTicketChange(tx, organizationId, ticket.row.id, false);
      return id;
    });
    return this.loadLink(organizationId, linkId);
  }

  async unlink(action: ActionContext, ticketId: string, linkId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      assertTicketPermission(action, 'jira.link', ticket);
      assertTicketUnlocked(ticket);
      const link = await tx.supportTicketJiraLink.findFirst({
        where: { organizationId, id: linkId, ticketId: ticket.row.id },
        select: { id: true, linkType: true, issue: { select: { id: true, issueKey: true, jiraIssueId: true } } },
      });
      if (link === null) {
        throw new NotFoundError('Jira link');
      }
      await tx.supportTicketJiraLink.deleteMany({ where: { organizationId, id: link.id } });
      await recordTicketEvent(tx, organizationId, ticket.row.id, {
        type: 'JIRA_UNLINKED',
        actorMemberId: action.principal.memberId,
        from: { issueKey: link.issue.issueKey, linkType: link.linkType },
        metadata: { issueId: link.issue.id, jiraIssueId: link.issue.jiraIssueId },
      });
      await recordAudit(tx, organizationId, {
        action: 'jira.link.removed',
        entityType: 'support_ticket',
        entityId: ticket.row.id,
        actor: userActor(action),
        metadata: { linkId: link.id, issueKey: link.issue.issueKey },
        context: action.request,
      });
      await announceTicketChange(tx, organizationId, ticket.row.id, false);
    });
  }

  /** Issue types creatable in a mapped project (live from Jira). */
  async issueTypes(
    action: ActionContext,
    ticketId: string,
    mappingId: string,
  ): Promise<{ id: string; name: string }[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    assertTicketPermission(action, 'jira.create_issue', ticket);
    const mapping = await this.ticketMapping(organizationId, ticket, mappingId);
    try {
      const types = await this.client(organizationId, [mapping]).creatableIssueTypes(mapping.jiraProjectId);
      return types.map((type) => ({ id: type.id, name: type.name }));
    } catch (error) {
      throw error instanceof JiraApiError ? toJiraDomainError(error, 'Jira project') : error;
    }
  }

  async createIssue(
    action: ActionContext,
    ticketId: string,
    input: CreateIssueInput,
    idempotencyKey: string,
  ): Promise<TicketJiraLinkView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    assertTicketPermission(action, 'jira.create_issue', ticket);
    assertTicketUnlocked(ticket);
    const mapping = await this.ticketMapping(organizationId, ticket, input.mappingId);
    const summary = input.summary.trim();
    const description = input.description.trim();
    const requestHash = createHash('sha256')
      .update(JSON.stringify([input.mappingId, input.issueTypeId, summary, description, input.linkType]))
      .digest('hex');

    const replay = await this.reserve(
      action,
      organizationId,
      ticket.row.id,
      idempotencyKey,
      input.mappingId,
      requestHash,
    );
    if (replay !== null) {
      return this.loadLink(organizationId, replay);
    }
    const client = this.client(organizationId, [mapping]);
    let issueTypeName: string;
    try {
      const types = await client.creatableIssueTypes(mapping.jiraProjectId);
      const type = types.find((candidate) => candidate.id === input.issueTypeId);
      if (type === undefined) {
        await this.settle(organizationId, ticket.row.id, idempotencyKey, 'FAILED', { errorCode: 'invalid_issue_type' });
        throw new InvalidInputError('issueTypeId', 'This issue type cannot be created in the Jira project.');
      }
      issueTypeName = type.name;
    } catch (error) {
      if (error instanceof JiraApiError) {
        await this.settle(organizationId, ticket.row.id, idempotencyKey, 'FAILED', { errorCode: error.code });
        throw toJiraDomainError(error, 'Jira project');
      }
      throw error;
    }

    const key = ticketKey(ticket.row.number);
    const url = `${this.appPublicUrl}/support/tickets/${encodeURIComponent(ticket.row.id)}`;
    let created: { id: string; key: string };
    try {
      created = await client.createIssue({
        project: { id: mapping.jiraProjectId },
        issuetype: { id: input.issueTypeId },
        summary,
        description: issueDescriptionAdf(description, { ticketKey: key, url }),
      });
    } catch (error) {
      if (error instanceof JiraApiError) {
        const ambiguous =
          error.kind === 'timeout' ||
          error.kind === 'malformed' ||
          (error.kind === 'unavailable' && error.retryAfterMs === null);
        await this.settle(organizationId, ticket.row.id, idempotencyKey, ambiguous ? 'UNKNOWN' : 'FAILED', {
          errorCode: error.code,
        });
        throw ambiguous ? new JiraCreateOutcomeUnknownError() : toJiraDomainError(error);
      }
      throw error;
    }

    let snapshot: JiraIssueSnapshot | null = null;
    try {
      snapshot = toSnapshot(await client.getIssue(created.id), mapping.connection.siteUrl);
    } catch (error) {
      if (!(error instanceof JiraApiError)) {
        throw error;
      }
    }
    const placement = await loadPlacement(this.db, organizationId, mapping.connectionId);
    const applied = await applySnapshot(
      this.db,
      placement,
      snapshot ?? {
        jiraIssueId: created.id,
        issueKey: created.key,
        jiraProjectId: mapping.jiraProjectId,
        summary: summary.slice(0, 1000),
        issueType: issueTypeName,
        statusName: 'Unknown',
        statusCategory: 'TODO',
        priorityName: null,
        assigneeAccountId: null,
        assigneeDisplayName: null,
        reporterDisplayName: null,
        jiraCreatedAt: this.now(),
        jiraUpdatedAt: new Date(0),
        dueDate: null,
        resolution: null,
        resolvedAt: null,
        labels: [],
        parentIssueId: null,
        url: issueBrowseUrl(mapping.connection.siteUrl, created.key),
      },
      { allowUnmapped: true, now: this.now() },
    );
    const issueRow = await this.db.jiraIssue.findFirstOrThrow({
      where: { organizationId, connectionId: mapping.connectionId, jiraIssueId: created.id },
      select: { id: true },
    });
    const issueId = applied.issueId ?? issueRow.id;

    const linkId = await this.db.$transaction(async (tx) => {
      const fresh = await loadVisibleTicket(tx, action, organizationId, ticket.row.id);
      const id =
        (await this.insertLink(
          tx,
          organizationId,
          fresh,
          issueId,
          input.linkType,
          'CREATED_FROM_TICKET',
          action.principal.memberId,
        )) ??
        (
          await tx.supportTicketJiraLink.findFirstOrThrow({
            where: { organizationId, ticketId: fresh.row.id, issueId },
            select: { id: true },
          })
        ).id;
      await tx.jiraIssueCreateRequest.updateMany({
        where: { organizationId, ticketId: fresh.row.id, idempotencyKey },
        data: { status: 'CREATED', jiraIssueId: created.id, linkId: id, errorCode: null },
      });
      const eventId = await recordTicketEvent(tx, organizationId, fresh.row.id, {
        type: 'JIRA_CREATED',
        actorMemberId: action.principal.memberId,
        to: { issueKey: created.key, linkType: input.linkType },
        metadata: { issueId, jiraIssueId: created.id },
      });
      await recordAudit(tx, organizationId, {
        action: 'jira.issue.created',
        entityType: 'support_ticket',
        entityId: fresh.row.id,
        actor: userActor(action),
        metadata: { issueKey: created.key, jiraIssueId: created.id, mappingId: mapping.id, linkId: id },
        context: action.request,
      });
      await notifyTicketAudience(
        tx,
        organizationId,
        fresh,
        [fresh.row.assigneeMemberId, ...(await watcherMemberIds(tx, organizationId, fresh.row.id))],
        {
          type: 'JIRA_ISSUE_CREATED',
          severity: 'INFO',
          email: false,
          causeId: eventId,
          requires: 'jira.view',
          params: { issueKey: created.key },
        },
        action.principal.memberId,
      );
      if (fresh.row.projectId !== null) {
        await recordProjectActivity(tx, organizationId, fresh.row.projectId, action.principal.memberId, {
          source: 'JIRA',
          type: 'jira.issue_created_from_ticket',
          entityType: 'support_ticket',
          entityId: fresh.row.id,
          summaryParams: { issueKey: created.key, ticketNumber: key },
        });
      }
      await announceTicketChange(tx, organizationId, fresh.row.id, false);
      return id;
    });
    return this.loadLink(organizationId, linkId);
  }

  /**
   * Reserves the create request. Returns the link id when the same request already succeeded
   * (replay), null when the caller should proceed; throws when another attempt is in flight, the
   * outcome of an earlier attempt is unknown, or the key was used for a different request.
   */
  private async reserve(
    action: ActionContext,
    organizationId: string,
    ticketId: string,
    idempotencyKey: string,
    mappingId: string,
    requestHash: string,
  ): Promise<string | null> {
    try {
      await this.db.jiraIssueCreateRequest.create({
        data: {
          organizationId,
          ticketId,
          idempotencyKey,
          mappingId,
          requestedByMemberId: action.principal.memberId,
          requestHash,
        },
        select: { id: true },
      });
      return null;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }
    const existing = await this.db.jiraIssueCreateRequest.findFirst({
      where: { organizationId, ticketId, idempotencyKey },
      select: { status: true, requestHash: true, linkId: true, updatedAt: true },
    });
    if (existing?.requestHash !== requestHash) {
      throw new ConflictError('This idempotency key was already used for a different request.');
    }
    if (existing.status === 'CREATED' && existing.linkId !== null) {
      return existing.linkId;
    }
    if (existing.status === 'UNKNOWN') {
      throw new JiraCreateOutcomeUnknownError();
    }
    if (existing.status === 'PENDING') {
      if (this.now().getTime() - existing.updatedAt.getTime() > PENDING_STALE_MS) {
        await this.settle(organizationId, ticketId, idempotencyKey, 'UNKNOWN', { errorCode: 'interrupted' }, 'PENDING');
        throw new JiraCreateOutcomeUnknownError();
      }
      throw new ConflictError('This Jira issue is already being created.');
    }
    const claimed = await this.db.jiraIssueCreateRequest.updateMany({
      where: { organizationId, ticketId, idempotencyKey, status: 'FAILED' },
      data: { status: 'PENDING', errorCode: null },
    });
    if (claimed.count === 0) {
      throw new ConflictError('This Jira issue is already being created.');
    }
    return null;
  }

  private async settle(
    organizationId: string,
    ticketId: string,
    idempotencyKey: string,
    status: 'FAILED' | 'UNKNOWN',
    fields: { errorCode: string },
    from: 'PENDING' = 'PENDING',
  ): Promise<void> {
    await this.db.jiraIssueCreateRequest.updateMany({
      where: { organizationId, ticketId, idempotencyKey, status: from },
      data: { status, errorCode: fields.errorCode.slice(0, 64) },
    });
  }

  private async insertLink(
    tx: TenantDb,
    organizationId: string,
    ticket: LoadedTicket,
    issueId: string,
    linkType: TicketJiraLinkType,
    createdVia: TicketJiraLinkSource,
    memberId: string,
  ): Promise<string | null> {
    const result = await tx.supportTicketJiraLink.createManyAndReturn({
      data: [{ organizationId, ticketId: ticket.row.id, issueId, linkType, createdVia, createdByMemberId: memberId }],
      skipDuplicates: true,
      select: { id: true },
    });
    return result[0]?.id ?? null;
  }

  private async loadLink(organizationId: string, linkId: string): Promise<TicketJiraLinkView> {
    const row = await this.db.supportTicketJiraLink.findFirst({
      where: { organizationId, id: linkId },
      select: linkSelect,
    });
    if (row === null) {
      throw new NotFoundError('Jira link');
    }
    return toLinkView(row);
  }

  private ticketMappings(
    organizationId: string,
    ticket: LoadedTicket,
    db: TenantDb = this.db,
  ): Promise<TicketMapping[]> {
    if (ticket.row.projectId === null) {
      return Promise.resolve([]);
    }
    return db.jiraProjectMapping.findMany({
      where: {
        organizationId,
        projectId: ticket.row.projectId,
        removedAt: null,
        connection: { status: { not: 'DISCONNECTED' } },
      },
      select: {
        id: true,
        connectionId: true,
        jiraProjectId: true,
        jiraProjectKey: true,
        jiraProjectName: true,
        connection: { select: { cloudId: true, siteUrl: true, status: true } },
      },
      orderBy: [{ jiraProjectKey: 'asc' }, { id: 'asc' }],
    });
  }

  private async requireMappings(
    organizationId: string,
    ticket: LoadedTicket,
    db: TenantDb = this.db,
  ): Promise<TicketMapping[]> {
    if (this.runtime === null) {
      throw new JiraNotConfiguredError();
    }
    const mappings = await this.ticketMappings(organizationId, ticket, db);
    if (mappings.length === 0) {
      throw new JiraNotConnectedError("This ticket's project is not mapped to a Jira project.");
    }
    if (mappings[0]?.connection.status === 'NEEDS_REAUTH') {
      throw new JiraReauthRequiredError();
    }
    return mappings;
  }

  private async ticketMapping(organizationId: string, ticket: LoadedTicket, mappingId: string): Promise<TicketMapping> {
    const mapping = (await this.requireMappings(organizationId, ticket)).find(
      (candidate) => candidate.id === mappingId,
    );
    if (mapping === undefined) {
      throw new InvalidInputError('mappingId', "Choose a Jira project mapped to the ticket's project.");
    }
    return mapping;
  }

  private client(organizationId: string, mappings: readonly TicketMapping[]): JiraClient {
    const mapping = mappings[0];
    if (this.runtime === null || mapping === undefined) {
      throw new JiraNotConfiguredError();
    }
    return this.runtime.clients.forConnection({
      organizationId,
      connectionId: mapping.connectionId,
      cloudId: mapping.connection.cloudId,
    });
  }
}
