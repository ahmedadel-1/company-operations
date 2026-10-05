import type { GithubPullRequestState, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { ConflictError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import {
  assertTicketPermission,
  assertTicketUnlocked,
  holdsOnTicket,
  loadVisibleTicket,
} from '../support/ticket-access.js';
import type { LoadedTicket } from '../support/ticket-access.js';
import { announceTicketChange } from '../support/ticket-notify.js';
import { LOCKED_TICKET_STATUSES } from '../support/ticket-state-machine.js';
import { DEFAULT_STALE_AFTER_MS, jiraVisibleProjects, pullViewSelect, toPullView } from './github-views.js';
import type { GithubPullView } from './github-views.js';

export interface TicketPullView extends GithubPullView {
  /** How the pull request relates to the ticket: through a linked Jira issue and/or directly. */
  readonly via: readonly ('JIRA' | 'MANUAL')[];
  /** Direct link id (removable), when linked directly. */
  readonly ticketLinkId: string | null;
}

export interface TicketGithubPanel {
  /** False when the caller may not see GitHub information on this ticket (no `github.view`). */
  readonly visible: boolean;
  /** The ticket's project has at least one mapped repository. */
  readonly available: boolean;
  readonly canLink: boolean;
  readonly pulls: readonly TicketPullView[];
}

export interface TicketPullOption {
  readonly id: string;
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly state: GithubPullRequestState;
  readonly linked: boolean;
}

const MAX_PULLS = 50;
const MAX_TICKET_LINKS = 20;
const SEARCH_LIMIT = 20;

/**
 * Pull requests on a support ticket (`github.view` on the ticket; changes need `github.link` on an
 * unlocked ticket). Shown are pull requests (a) confirmed-linked to a Jira issue the ticket is
 * linked to, and (b) linked to the ticket directly — in both cases only from repositories mapped to
 * the ticket's own project, so the panel never shows more than the project's GitHub tab would.
 */
export class GithubTicketService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly now: () => Date = () => new Date(),
    private readonly staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  ) {}

  async panel(action: ActionContext, ticketId: string): Promise<TicketGithubPanel> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    const projectId = ticket.row.projectId;
    const visible = holdsOnTicket(action.principal, 'github.view', ticket);
    if (!visible || projectId === null) {
      return { visible, available: false, canLink: false, pulls: [] };
    }
    const inProject: Prisma.GithubPullRequestWhereInput = {
      organizationId,
      repository: { mappings: { some: { projectId, removedAt: null } } },
    };
    // Sequential: the tenant client is one transaction connection, which cannot run queries concurrently.
    const mapped = await this.db.githubRepositoryMapping.count({
      where: { organizationId, projectId, removedAt: null },
    });
    const issueLinks = await this.db.supportTicketJiraLink.findMany({
      where: { organizationId, ticketId: ticket.row.id },
      select: { issueId: true },
      take: 50,
    });
    const direct = await this.db.supportTicketGithubLink.findMany({
      where: { organizationId, ticketId: ticket.row.id, pullRequest: inProject },
      select: { id: true, pullRequestId: true },
      take: MAX_TICKET_LINKS,
    });
    const issueIds = issueLinks.map((link) => link.issueId);
    const viaJira =
      issueIds.length === 0
        ? []
        : await this.db.githubPrJiraLink.findMany({
            where: { organizationId, issueId: { in: issueIds }, state: 'CONFIRMED', pullRequest: inProject },
            select: { pullRequestId: true },
            take: MAX_PULLS,
          });
    const jiraIds = new Set(viaJira.map((row) => row.pullRequestId));
    const directIds = new Map(direct.map((row) => [row.pullRequestId, row.id]));
    const ids = [...new Set([...jiraIds, ...directIds.keys()])];
    const rows =
      ids.length === 0
        ? []
        : await this.db.githubPullRequest.findMany({
            where: { ...inProject, id: { in: ids } },
            orderBy: [{ ghUpdatedAt: 'desc' }, { id: 'desc' }],
            take: MAX_PULLS,
            select: pullViewSelect,
          });
    const jiraProjects = await jiraVisibleProjects(this.db, action, organizationId, rows);
    const now = this.now();
    return {
      visible: true,
      available: mapped > 0,
      canLink: mapped > 0 && this.mayLink(action, ticket),
      pulls: rows.map((row) => {
        const via: ('JIRA' | 'MANUAL')[] = [];
        if (jiraIds.has(row.id)) {
          via.push('JIRA');
        }
        if (directIds.has(row.id)) {
          via.push('MANUAL');
        }
        return {
          ...toPullView(row, jiraProjects, now, this.staleAfterMs),
          via,
          ticketLinkId: directIds.get(row.id) ?? null,
        };
      }),
    };
  }

  /** Pull requests of the ticket's project repositories (local cache) for the link picker. */
  async searchPulls(action: ActionContext, ticketId: string, q: string): Promise<TicketPullOption[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    assertTicketPermission(action, 'github.link', ticket);
    const projectId = this.requireProject(ticket);
    const query = q.trim().slice(0, 100);
    const number = /^#?([1-9][0-9]{0,8})$/.exec(query)?.[1];
    const rows = await this.db.githubPullRequest.findMany({
      where: {
        organizationId,
        repository: { mappings: { some: { projectId, removedAt: null } } },
        ...(query === ''
          ? {}
          : number === undefined
            ? { title: { contains: query, mode: 'insensitive' } }
            : { OR: [{ number: Number(number) }, { title: { contains: query, mode: 'insensitive' } }] }),
      },
      orderBy: [{ ghUpdatedAt: 'desc' }, { id: 'desc' }],
      take: SEARCH_LIMIT,
      select: { id: true, number: true, title: true, state: true, repository: { select: { fullName: true } } },
    });
    const linked = new Set(
      (
        await this.db.supportTicketGithubLink.findMany({
          where: { organizationId, ticketId: ticket.row.id, pullRequestId: { in: rows.map((row) => row.id) } },
          select: { pullRequestId: true },
        })
      ).map((row) => row.pullRequestId),
    );
    return rows.map((row) => ({
      id: row.id,
      repository: row.repository.fullName,
      number: row.number,
      title: row.title,
      state: row.state,
      linked: linked.has(row.id),
    }));
  }

  async linkPull(action: ActionContext, ticketId: string, pullRequestId: string): Promise<TicketGithubPanel> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      assertTicketPermission(action, 'github.link', ticket);
      assertTicketUnlocked(ticket);
      const projectId = this.requireProject(ticket);
      const pull = await tx.githubPullRequest.findFirst({
        where: {
          organizationId,
          id: pullRequestId,
          repository: { mappings: { some: { projectId, removedAt: null } } },
        },
        select: { id: true, number: true, repository: { select: { fullName: true } } },
      });
      if (pull === null) {
        throw new NotFoundError('Pull request');
      }
      const count = await tx.supportTicketGithubLink.count({ where: { organizationId, ticketId: ticket.row.id } });
      if (count >= MAX_TICKET_LINKS) {
        throw new InvalidInputError(
          'pullRequestId',
          'This ticket has reached the maximum number of pull request links.',
        );
      }
      let linkId: string;
      try {
        const created = await tx.supportTicketGithubLink.create({
          data: {
            organizationId,
            ticketId: ticket.row.id,
            pullRequestId: pull.id,
            createdByMemberId: action.principal.memberId,
          },
          select: { id: true },
        });
        linkId = created.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('This pull request is already linked to the ticket.');
        }
        throw error;
      }
      await recordAudit(tx, organizationId, {
        action: 'github.ticket_link.created',
        entityType: 'support_ticket',
        entityId: ticket.row.id,
        actor: userActor(action),
        metadata: { linkId, pullRequestId: pull.id, repository: pull.repository.fullName, number: pull.number },
        context: action.request,
      });
      await announceTicketChange(tx, organizationId, ticket.row.id, false);
    });
    return this.panel(action, ticketId);
  }

  async unlinkPull(action: ActionContext, ticketId: string, linkId: string): Promise<void> {
    const organizationId = boundOrganizationId(this.tenant, action);
    await this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      assertTicketPermission(action, 'github.link', ticket);
      assertTicketUnlocked(ticket);
      const link = await tx.supportTicketGithubLink.findFirst({
        where: { organizationId, id: linkId, ticketId: ticket.row.id },
        select: {
          id: true,
          pullRequestId: true,
          pullRequest: { select: { number: true, repository: { select: { fullName: true } } } },
        },
      });
      if (link === null) {
        throw new NotFoundError('Pull request link');
      }
      await tx.supportTicketGithubLink.deleteMany({ where: { organizationId, id: link.id } });
      await recordAudit(tx, organizationId, {
        action: 'github.ticket_link.removed',
        entityType: 'support_ticket',
        entityId: ticket.row.id,
        actor: userActor(action),
        metadata: {
          linkId: link.id,
          pullRequestId: link.pullRequestId,
          repository: link.pullRequest.repository.fullName,
          number: link.pullRequest.number,
        },
        context: action.request,
      });
      await announceTicketChange(tx, organizationId, ticket.row.id, false);
    });
  }

  private mayLink(action: ActionContext, ticket: LoadedTicket): boolean {
    return (
      !LOCKED_TICKET_STATUSES.includes(ticket.row.status) && holdsOnTicket(action.principal, 'github.link', ticket)
    );
  }

  private requireProject(ticket: LoadedTicket): string {
    if (ticket.row.projectId === null) {
      throw new InvalidInputError('ticketId', 'Assign the ticket to a project before linking pull requests.');
    }
    return ticket.row.projectId;
  }
}
