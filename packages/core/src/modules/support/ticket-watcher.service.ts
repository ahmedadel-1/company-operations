import { InvalidInputError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { loadMemberAccess } from '../authorization/member-access.js';
import { assertTicketPermission, assertTicketUnlocked, holdsOnTicket, loadVisibleTicket } from './ticket-access.js';
import type { LoadedTicket } from './ticket-access.js';
import { recordTicketEvent } from './ticket-history.js';
import { memberRefSelect, toPersonRef } from './ticket-views.js';
import type { TicketPersonRef } from './ticket-views.js';

export interface TicketWatcherView {
  readonly member: TicketPersonRef;
  readonly addedAt: string;
}

const MAX_WATCHERS = 200;

/**
 * Ticket watchers (notified of changes). Anyone who can view a ticket may watch or unwatch it;
 * adding or removing other members needs `support.assign`, and a watcher must be an active member
 * of the same organization who can view the ticket in their own right. One row per member.
 */
export class TicketWatcherService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async list(action: ActionContext, ticketId: string): Promise<TicketWatcherView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    const ticket = await loadVisibleTicket(this.db, action, organizationId, ticketId);
    return this.load(this.db, organizationId, ticket.row.id);
  }

  async add(action: ActionContext, ticketId: string, memberId: string): Promise<TicketWatcherView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      assertTicketUnlocked(ticket);
      const self = memberId === action.principal.memberId;
      if (!self) {
        assertTicketPermission(action, 'support.assign', ticket);
      }
      const target = (await loadMemberAccess(tx, organizationId, [memberId])).get(memberId);
      if (target === undefined || !holdsOnTicket(target.principal, 'support.view', ticket)) {
        throw new InvalidInputError('memberId', 'This member cannot view the ticket.');
      }
      const existing = await tx.supportTicketWatcher.count({ where: { organizationId, ticketId: ticket.row.id } });
      if (existing >= MAX_WATCHERS) {
        throw new InvalidInputError('memberId', 'This ticket has reached the maximum number of watchers.');
      }
      const created = await this.insert(tx, organizationId, ticket, memberId, action.principal.memberId);
      if (created) {
        await recordTicketEvent(tx, organizationId, ticket.row.id, {
          type: 'WATCHER_ADDED',
          actorMemberId: action.principal.memberId,
          to: { memberId },
        });
      }
      return this.load(tx, organizationId, ticket.row.id);
    });
  }

  async remove(action: ActionContext, ticketId: string, memberId: string): Promise<TicketWatcherView[]> {
    const organizationId = boundOrganizationId(this.tenant, action);
    return this.db.$transaction(async (tx) => {
      const ticket = await loadVisibleTicket(tx, action, organizationId, ticketId);
      if (memberId !== action.principal.memberId) {
        assertTicketPermission(action, 'support.assign', ticket);
      }
      const removed = await tx.supportTicketWatcher.deleteMany({
        where: { organizationId, ticketId: ticket.row.id, memberId },
      });
      if (removed.count > 0) {
        await recordTicketEvent(tx, organizationId, ticket.row.id, {
          type: 'WATCHER_REMOVED',
          actorMemberId: action.principal.memberId,
          from: { memberId },
        });
      }
      return this.load(tx, organizationId, ticket.row.id);
    });
  }

  /** Inserts the watcher row; an existing row (concurrent duplicate) is a no-op. */
  private async insert(
    db: TenantDb,
    organizationId: string,
    ticket: LoadedTicket,
    memberId: string,
    addedByMemberId: string,
  ): Promise<boolean> {
    const result = await db.supportTicketWatcher.createMany({
      data: [{ organizationId, ticketId: ticket.row.id, memberId, addedByMemberId }],
      skipDuplicates: true,
    });
    return result.count > 0;
  }

  private async load(db: TenantDb, organizationId: string, ticketId: string): Promise<TicketWatcherView[]> {
    const rows = await db.supportTicketWatcher.findMany({
      where: { organizationId, ticketId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_WATCHERS,
      select: { createdAt: true, member: { select: memberRefSelect } },
    });
    return rows.map((row) => ({ member: toPersonRef(row.member), addedAt: row.createdAt.toISOString() }));
  }
}
