import type { Prisma, TicketCommentVisibility } from '@company-ops/db';

import { ForbiddenError, InvalidInputError, NotFoundError } from '../../platform/errors.js';
import { decodeCursor, pageSize, toPage } from '../../platform/pagination/cursor.js';
import type { Page } from '../../platform/pagination/cursor.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import type { AttachmentChange, AttachmentOwnerPolicy, OwnerAccess } from '../attachments/attachment.service.js';
import {
  assertTicketPermission,
  assertTicketUnlocked,
  holdsOnTicket,
  loadTicketForAccess,
  loadVisibleTicket,
} from './ticket-access.js';
import type { LoadedTicket } from './ticket-access.js';
import { recordTicketEvent } from './ticket-history.js';
import { announceTicketChange, notifyTicketAudience, teamMemberIds, watcherMemberIds } from './ticket-notify.js';
import { recordSlaConditions, SlaContext, slaColumns, snapshotOf } from './ticket-sla.js';
import { LOCKED_TICKET_STATUSES, transitionRule } from './ticket-state-machine.js';
import { applyTransition } from './ticket-workflow.js';
import { memberRefSelect, toPersonRef } from './ticket-views.js';
import type { TicketPersonRef } from './ticket-views.js';

export const TICKET_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export interface TicketCommentView {
  readonly id: string;
  readonly body: string;
  readonly visibility: TicketCommentVisibility;
  readonly author: TicketPersonRef;
  readonly createdAt: string;
  readonly editedAt: string | null;
  readonly canEdit: boolean;
}

const commentSelect = {
  id: true,
  body: true,
  visibility: true,
  authorMemberId: true,
  createdAt: true,
  editedAt: true,
  author: { select: memberRefSelect },
} satisfies Prisma.SupportTicketCommentSelect;

type CommentRow = Prisma.SupportTicketCommentGetPayload<{ select: typeof commentSelect }>;

/**
 * Ticket comments and internal notes. Public comments (`PUBLIC_INTERNAL`: visible to everyone who
 * can view the ticket, including its reporter) need `support.comment`; internal notes need
 * `support.internal_note` to write AND to read: they are filtered out of every read path for other
 * members, and notifications about them only go to holders. Bodies are stored and returned as plain
 * text and never copied into notifications, emails, history or audit rows. Comments are never
 * deleted; authors may edit their own while the ticket is not closed or cancelled.
 */
export class TicketCommentService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(
    action: ActionContext,
    ticketId: string,
    paging: { readonly cursor?: string | undefined; readonly limit?: number | undefined },
  ): Promise<Page<TicketCommentView>> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    const size = pageSize(paging.limit);
    const and: Prisma.SupportTicketCommentWhereInput[] = [];
    if (!holdsOnTicket(action.principal, 'support.internal_note', ticket)) {
      and.push({ visibility: 'PUBLIC_INTERNAL' });
    }
    if (paging.cursor !== undefined) {
      const [value = '', id = ''] = decodeCursor(paging.cursor, 2);
      const key = new Date(value);
      if (Number.isNaN(key.getTime())) {
        throw new InvalidInputError('cursor', 'The cursor is invalid.');
      }
      and.push({ OR: [{ createdAt: { gt: key } }, { createdAt: key, id: { gt: id } }] });
    }
    const rows = await this.db.supportTicketComment.findMany({
      where: { organizationId, ticketId: ticket.row.id, AND: and },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: size + 1,
      select: commentSelect,
    });
    const page = toPage(rows, size, (row) => [row.createdAt.toISOString(), row.id]);
    return { items: page.items.map((row) => this.toView(action, ticket, row)), nextCursor: page.nextCursor };
  }

  async add(
    action: ActionContext,
    ticketId: string,
    input: { readonly body: string; readonly visibility: TicketCommentVisibility },
  ): Promise<TicketCommentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const now = this.clock();
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      const internal = input.visibility === 'INTERNAL_NOTE';
      assertTicketPermission(action, internal ? 'support.internal_note' : 'support.comment', ticket);
      assertTicketUnlocked(ticket);
      const authorMemberId = action.principal.memberId;
      const { row } = ticket;
      const created = await tx.supportTicketComment.create({
        data: { organizationId, ticketId: row.id, authorMemberId, body: input.body, visibility: input.visibility },
        select: commentSelect,
      });
      const eventId = await recordTicketEvent(tx, organizationId, row.id, {
        type: internal ? 'INTERNAL_NOTE_ADDED' : 'COMMENTED',
        actorMemberId: authorMemberId,
        metadata: { commentId: created.id },
      });
      const isReporter = authorMemberId === row.reporterMemberId;
      if (!internal && !isReporter && row.firstRespondedAt === null) {
        await this.recordFirstResponse(tx, organizationId, ticket, now);
      }
      if (!internal && isReporter && row.status === 'WAITING_FOR_CUSTOMER') {
        const rule = transitionRule('WAITING_FOR_CUSTOMER', 'IN_PROGRESS');
        const fresh = await loadTicketForAccess(tx, organizationId, row.id);
        if (rule !== null && fresh !== null) {
          await applyTransition(
            tx,
            organizationId,
            fresh,
            {
              to: 'IN_PROGRESS',
              rule,
              note: null,
              actorMemberId: authorMemberId,
              expectedVersion: fresh.row.version,
              reason: 'reporter_replied',
            },
            now,
          );
        }
      }

      const watchers = await watcherMemberIds(tx, organizationId, row.id);
      if (internal) {
        await notifyTicketAudience(
          tx,
          organizationId,
          ticket,
          [row.assigneeMemberId, ...watchers],
          {
            type: 'SUPPORT_TICKET_INTERNAL_NOTE',
            severity: 'INFO',
            email: false,
            causeId: eventId,
            requires: 'support.internal_note',
          },
          authorMemberId,
        );
      } else {
        const direct = isReporter
          ? row.assigneeMemberId === null
            ? await teamMemberIds(tx, organizationId, row.assignedTeamId)
            : [row.assigneeMemberId]
          : [row.reporterMemberId];
        await notifyTicketAudience(
          tx,
          organizationId,
          ticket,
          direct,
          {
            type: isReporter ? 'SUPPORT_TICKET_REPORTER_REPLIED' : 'SUPPORT_TICKET_REPLIED',
            severity: 'INFO',
            email: true,
            causeId: eventId,
          },
          authorMemberId,
        );
        const others = [row.reporterMemberId, row.assigneeMemberId, ...watchers].filter(
          (memberId) => memberId !== null && !direct.includes(memberId),
        );
        await notifyTicketAudience(
          tx,
          organizationId,
          ticket,
          others,
          { type: 'SUPPORT_TICKET_COMMENTED', severity: 'INFO', email: false, causeId: eventId },
          authorMemberId,
        );
      }
      await announceTicketChange(tx, organizationId, row.id, false);
      return this.toView(action, ticket, created);
    });
  }

  async edit(
    action: ActionContext,
    ticketId: string,
    commentId: string,
    input: { readonly body: string },
  ): Promise<TicketCommentView> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      const comment = await tx.supportTicketComment.findFirst({
        where: { organizationId, id: commentId, ticketId: ticket.row.id },
        select: commentSelect,
      });
      const internal = comment?.visibility === 'INTERNAL_NOTE';
      if (comment === null || (internal && !holdsOnTicket(action.principal, 'support.internal_note', ticket))) {
        throw new NotFoundError('Comment');
      }
      if (comment.authorMemberId !== action.principal.memberId) {
        throw new ForbiddenError('Only the author can edit a comment.');
      }
      assertTicketPermission(action, internal ? 'support.internal_note' : 'support.comment', ticket);
      assertTicketUnlocked(ticket);
      if (comment.body === input.body) {
        return this.toView(action, ticket, comment);
      }
      const now = this.clock();
      await tx.supportTicketComment.updateMany({
        where: { organizationId, id: comment.id },
        data: { body: input.body, editedAt: now },
      });
      await recordTicketEvent(tx, organizationId, ticket.row.id, {
        type: internal ? 'INTERNAL_NOTE_EDITED' : 'COMMENT_EDITED',
        actorMemberId: action.principal.memberId,
        metadata: { commentId: comment.id },
      });
      await announceTicketChange(tx, organizationId, ticket.row.id, false);
      return this.toView(action, ticket, { ...comment, body: input.body, editedAt: now });
    });
  }

  /**
   * Attachment rules for a ticket: everyone who can view it can view its files (attachments are
   * ticket-level and as visible as public comments); members who may comment can upload while the
   * ticket is not closed or cancelled; triagers may remove files.
   */
  async attachmentAccess(action: ActionContext, ticketId: string): Promise<OwnerAccess> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadTicketForAccess(this.db, organizationId, ticketId);
    if (ticket === null || !holdsOnTicket(action.principal, 'support.view', ticket)) {
      return { canView: false, canUpload: false, canDelete: false };
    }
    const live = !LOCKED_TICKET_STATUSES.includes(ticket.row.status);
    return {
      canView: true,
      canUpload: live && holdsOnTicket(action.principal, 'support.comment', ticket),
      canDelete: live && holdsOnTicket(action.principal, 'support.triage', ticket),
    };
  }

  /** First public response by someone other than the reporter stops the first-response clock. */
  private async recordFirstResponse(
    db: TenantDb,
    organizationId: string,
    ticket: LoadedTicket,
    now: Date,
  ): Promise<void> {
    const { row } = ticket;
    const data: Prisma.SupportTicketUncheckedUpdateManyInput = { firstRespondedAt: now };
    const policy = await new SlaContext(db, organizationId).policyOf(row, row.project?.timeZone ?? null);
    let reached: Awaited<ReturnType<typeof slaColumns>>['reached'] = [];
    if (policy !== null) {
      const evaluated = slaColumns(policy, { ...snapshotOf(row), firstRespondedAt: now }, now);
      data.firstResponseSlaState = evaluated.columns.firstResponseSlaState;
      data.resolutionSlaState = evaluated.columns.resolutionSlaState;
      reached = evaluated.reached;
    }
    const updated = await db.supportTicket.updateMany({
      where: { organizationId, id: row.id, firstRespondedAt: null },
      data,
    });
    if (updated.count > 0 && reached.length > 0) {
      await recordSlaConditions(db, organizationId, ticket, reached);
    }
  }

  private toView(action: ActionContext, ticket: LoadedTicket, row: CommentRow): TicketCommentView {
    const own = row.authorMemberId === action.principal.memberId;
    const permission = row.visibility === 'INTERNAL_NOTE' ? 'support.internal_note' : 'support.comment';
    return {
      id: row.id,
      body: row.body,
      visibility: row.visibility,
      author: toPersonRef(row.author),
      createdAt: row.createdAt.toISOString(),
      editedAt: row.editedAt?.toISOString() ?? null,
      canEdit:
        own &&
        !LOCKED_TICKET_STATUSES.includes(ticket.row.status) &&
        holdsOnTicket(action.principal, permission, ticket),
    };
  }
}

export class SupportTicketAttachmentPolicy implements AttachmentOwnerPolicy {
  readonly ownerType = 'SUPPORT_TICKET' as const;
  readonly allowedContentTypes = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf',
    'text/plain',
    'text/csv',
  ] as const;
  readonly maxSizeBytes = TICKET_ATTACHMENT_MAX_BYTES;
  readonly listable = true;

  constructor(private readonly comments: TicketCommentService) {}

  access(action: ActionContext, ownerId: string): Promise<OwnerAccess> {
    return this.comments.attachmentAccess(action, ownerId);
  }

  async recordChange(tx: TenantDb, change: AttachmentChange): Promise<void> {
    await recordTicketEvent(tx, change.organizationId, change.ownerId, {
      type: change.kind === 'ADDED' ? 'ATTACHMENT_ADDED' : 'ATTACHMENT_REMOVED',
      actorMemberId: change.actorMemberId,
      metadata: { attachmentId: change.attachmentId, filename: change.filename },
    });
  }
}
