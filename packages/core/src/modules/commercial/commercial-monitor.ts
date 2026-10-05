import type { Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockCommercialAggregate } from '../../platform/db/sql/locks.js';
import { requireAnyTenantContext } from '../../platform/tenancy/tenant-context.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { canAccessResource } from '../authorization/policy.js';
import type { Principal } from '../authorization/policy.js';
import { addDays, daysBetween, localToday } from '../projects/business-date.js';
import {
  canViewCorporate,
  contractAccessSelect,
  contractFacts,
  corporateAccessSelect,
  corporateFacts,
  loadContractForAccess,
  loadTenderForAccess,
  tenderAccessSelect,
  tenderFacts,
} from './commercial-access.js';
import {
  announceCommercialChange,
  appendContractEvent,
  appendTenderEvent,
  dateOnly,
  notifyMembers,
  organizationToday,
  permissionHolderIds,
} from './commercial-support.js';
import type { CommercialNotification } from './commercial-support.js';
import { loadReminderSettings } from './commercial-settings.service.js';
import { refreshContract } from './contract-refresh.js';
import {
  CLOSED_CONTRACT_STATUSES,
  contractKey,
  LIVE_CONTRACT_STATUSES,
  MONITORED_CONTRACT_STATUSES,
} from './engine/contract-state.js';
import { deadlineReminderThreshold, dueReminderThreshold } from './engine/dates.js';
import { readinessState } from './engine/readiness.js';
import { RECURRENCE_HORIZON_DAYS } from './engine/recurrence.js';
import { ACTIVE_TENDER_STATUSES, tenderKey } from './engine/tender-state.js';
import { extendObligation } from './obligation-generation.js';

export const COMMERCIAL_MONITOR_BATCH_SIZE = 200;
/** Readiness below READY inside this many days of the deadline raises a low-readiness warning. */
export const LOW_READINESS_DAYS = 7;

export interface CommercialMonitorResult {
  readonly reminders: number;
  readonly contractsExpired: number;
  readonly guaranteesExpired: number;
  readonly occurrencesGenerated: number;
  readonly contractsRefreshed: number;
}

interface ReminderKey {
  readonly entityType: string;
  readonly entityId: string;
  readonly kind: string;
  readonly thresholdDays: number;
  readonly dueOn: string;
}

interface RunContext {
  readonly organizationId: string;
  readonly now: Date;
  readonly today: string;
  readonly timeZone: string;
}

const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const maxOf = (values: readonly number[]): number => values.reduce((max, value) => Math.max(max, value), 0);
const OPEN_REQUIREMENT: Prisma.EnumTenderRequirementStatusFilter<'TenderRequirement'> = {
  notIn: ['APPROVED', 'NOT_APPLICABLE'],
};
const SYSTEM = { type: 'SYSTEM' } as const;

/**
 * The commercial monitor (spec §54-§56, `commercial.monitor` on the `commercial` queue) for the
 * organization of the active system tenant context. One pass:
 * - deadline, due-date and expiry reminders (tenders, requirements, corporate documents, contracts,
 *   renewal decision and notice dates, obligation occurrences, milestones, guarantees);
 * - lifecycle facts that follow from the calendar: a live contract past its expiry becomes EXPIRED
 *   (renewals are explicit actions, never silent), an ACTIVE guarantee past its expiry becomes
 *   EXPIRED; nothing is ever completed automatically;
 * - recurring obligation occurrences up to the horizon, and the daily contract health refresh.
 *
 * Every notification is claimed through a unique `commercial_reminders` row in the same transaction
 * (entity, kind, threshold, date), so retries, overlapping workers and duplicated schedulers never
 * notify twice. Only the smallest due threshold is sent, so a monitor that was down sends one
 * reminder, not every threshold it missed. Recipients are re-checked against their current grants.
 * Work is read in id-ordered batches; state changes are conditional updates under the aggregate lock.
 */
export class CommercialMonitor {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async run(now: Date): Promise<CommercialMonitorResult> {
    const { organizationId } = requireAnyTenantContext(this.tenant);
    const { today, timeZone } = await organizationToday(this.db, organizationId, now);
    const settings = await loadReminderSettings(this.db, organizationId);
    const c: RunContext = { organizationId, now, today, timeZone };
    let reminders = 0;
    const contractsExpired = await this.expireContracts(c);
    const guarantees = await this.guarantees(c, settings.guaranteeReminderDays);
    const occurrencesGenerated = await this.extendRecurrences(c);
    reminders += guarantees.reminders;
    reminders += await this.tenderDeadlines(c, settings.tenderReminderDays);
    reminders += await this.requirementDeadlines(c, settings.obligationReminderDays);
    reminders += await this.corporateDocuments(c, settings.documentReminderDays);
    reminders += await this.contractDates(c, settings.contractReminderDays);
    reminders += await this.occurrences(c, settings.obligationReminderDays);
    reminders += await this.milestones(c, settings.obligationReminderDays);
    const contractsRefreshed = await this.dailyRefresh(c);
    if (contractsExpired + guarantees.expired + occurrencesGenerated + contractsRefreshed > 0) {
      await announceCommercialChange(this.db, organizationId, 'organization', organizationId);
    }
    return {
      reminders,
      contractsExpired,
      guaranteesExpired: guarantees.expired,
      occurrencesGenerated,
      contractsRefreshed,
    };
  }

  // ---- helpers ----

  /** Claims a reminder (false when it was already sent) inside the caller's transaction. */
  private async claim(tx: TenantDb, organizationId: string, key: ReminderKey): Promise<boolean> {
    const result = await tx.commercialReminder.createMany({
      data: [{ organizationId, ...key, dueOn: day(key.dueOn) }],
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  /** Claim and notify atomically; returns 1 when the reminder was new. */
  private async remind(c: RunContext, key: ReminderKey, send: (tx: TenantDb) => Promise<unknown>): Promise<number> {
    return this.db.$transaction(async (tx) => {
      if (!(await this.claim(tx, c.organizationId, key))) return 0;
      await send(tx);
      return 1;
    });
  }

  private async batches<T extends { readonly id: string }>(
    fetch: (after: string | null) => Promise<T[]>,
    handle: (row: T) => Promise<void>,
  ): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const rows = await fetch(after);
      for (const row of rows) await handle(row);
      const last = rows.at(-1);
      if (last === undefined || rows.length < COMMERCIAL_MONITOR_BATCH_SIZE) return;
      after = last.id;
    }
  }

  private notifyContract(
    tx: TenantDb,
    c: RunContext,
    contract: Prisma.ContractGetPayload<{ select: typeof contractAccessSelect }>,
    recipients: readonly (string | null)[],
    notification: Omit<CommercialNotification, 'entityType' | 'entityId'>,
  ): Promise<number> {
    const facts = contractFacts(c.organizationId, contract);
    return notifyMembers(
      tx,
      c.organizationId,
      recipients,
      { ...notification, entityType: 'contract', entityId: contract.id },
      async (principal: Principal) =>
        canAccessResource(principal, 'contract.view', facts) ||
        (await loadContractForAccess(tx, principal, c.organizationId, contract.id)) !== null,
      null,
    );
  }

  private notifyTender(
    tx: TenantDb,
    c: RunContext,
    tender: Prisma.TenderGetPayload<{ select: typeof tenderAccessSelect }>,
    recipients: readonly (string | null)[],
    notification: Omit<CommercialNotification, 'entityType' | 'entityId'>,
  ): Promise<number> {
    const facts = tenderFacts(c.organizationId, tender);
    return notifyMembers(
      tx,
      c.organizationId,
      recipients,
      { ...notification, entityType: 'tender', entityId: tender.id },
      async (principal: Principal) =>
        canAccessResource(principal, 'tender.view', facts) ||
        (await loadTenderForAccess(tx, principal, c.organizationId, tender.id)) !== null,
      null,
    );
  }

  // ---- lifecycle facts ----

  private async expireContracts(c: RunContext): Promise<number> {
    let expired = 0;
    await this.batches(
      (after) =>
        this.db.contract.findMany({
          where: {
            organizationId: c.organizationId,
            status: { in: [...LIVE_CONTRACT_STATUSES] },
            renewalType: { not: 'EVERGREEN' },
            currentExpiryDate: { lt: day(c.today) },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: { id: true },
        }),
      async (row) => {
        const done = await this.db.$transaction(async (tx) => {
          await lockCommercialAggregate(tx, c.organizationId, 'contract', row.id);
          const contract = await tx.contract.findFirstOrThrow({
            where: { organizationId: c.organizationId, id: row.id },
            select: { ...contractAccessSelect, currentExpiryDate: true },
          });
          const updated = await tx.contract.updateMany({
            where: {
              organizationId: c.organizationId,
              id: row.id,
              status: { in: [...LIVE_CONTRACT_STATUSES] },
              renewalType: { not: 'EVERGREEN' },
              currentExpiryDate: { lt: day(c.today) },
            },
            data: { status: 'EXPIRED', statusReason: null, version: { increment: 1 } },
          });
          if (updated.count === 0) return false;
          const expiry = dateOnly(contract.currentExpiryDate) ?? c.today;
          await appendContractEvent(tx, c.organizationId, row.id, 'contract.status_changed', null, {
            from: contract.status,
            to: 'EXPIRED',
            reason: 'expiry_passed',
          });
          await recordAudit(tx, c.organizationId, {
            action: 'contract.expired',
            entityType: 'contract',
            entityId: row.id,
            actor: SYSTEM,
            metadata: { from: contract.status, expiryDate: expiry },
          });
          await refreshContract(tx, c.organizationId, row.id, c.today);
          if (
            await this.claim(tx, c.organizationId, {
              entityType: 'CONTRACT',
              entityId: row.id,
              kind: 'EXPIRED',
              thresholdDays: 0,
              dueOn: expiry,
            })
          ) {
            await this.notifyContract(tx, c, contract, [contract.ownerMemberId], {
              type: 'CONTRACT_EXPIRED',
              severity: 'CRITICAL',
              params: {
                contractKey: contractKey(contract.year, contract.number),
                contractTitle: contract.title,
                expiryDate: expiry,
              },
              dedupeKey: `CONTRACT_EXPIRED:${row.id}:${expiry}`,
              email: true,
            });
          }
          return true;
        });
        if (done) expired += 1;
      },
    );
    return expired;
  }

  private async guarantees(
    c: RunContext,
    thresholds: readonly number[],
  ): Promise<{ expired: number; reminders: number }> {
    let expired = 0;
    let reminders = 0;
    const horizon = day(addDays(c.today, maxOf(thresholds)));
    await this.batches(
      (after) =>
        this.db.guarantee.findMany({
          where: {
            organizationId: c.organizationId,
            status: 'ACTIVE',
            expiryDate: { lte: horizon },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: {
            id: true,
            type: true,
            referenceNumber: true,
            expiryDate: true,
            ownerMemberId: true,
            tenderId: true,
            contractId: true,
          },
        }),
      async (row) => {
        const expiry = dateOnly(row.expiryDate) ?? c.today;
        const parentLabel = async (
          tx: TenantDb,
        ): Promise<{
          key: string;
          notify: (n: Omit<CommercialNotification, 'entityType' | 'entityId'>) => Promise<number>;
        } | null> => {
          if (row.contractId !== null) {
            const contract = await tx.contract.findFirst({
              where: { organizationId: c.organizationId, id: row.contractId },
              select: contractAccessSelect,
            });
            if (contract === null || CLOSED_CONTRACT_STATUSES.includes(contract.status)) return null;
            return {
              key: contractKey(contract.year, contract.number),
              notify: (n) => this.notifyContract(tx, c, contract, [row.ownerMemberId, contract.ownerMemberId], n),
            };
          }
          if (row.tenderId !== null) {
            const tender = await tx.tender.findFirst({
              where: { organizationId: c.organizationId, id: row.tenderId },
              select: tenderAccessSelect,
            });
            if (tender === null) return null;
            return {
              key: tenderKey(tender.year, tender.number),
              notify: (n) => this.notifyTender(tx, c, tender, [row.ownerMemberId, tender.ownerMemberId], n),
            };
          }
          return null;
        };
        if (expiry < c.today) {
          const done = await this.db.$transaction(async (tx) => {
            if (row.contractId !== null)
              await lockCommercialAggregate(tx, c.organizationId, 'contract', row.contractId);
            const updated = await tx.guarantee.updateMany({
              where: {
                organizationId: c.organizationId,
                id: row.id,
                status: 'ACTIVE',
                expiryDate: { lt: day(c.today) },
              },
              data: { status: 'EXPIRED', version: { increment: 1 } },
            });
            if (updated.count === 0) return false;
            const metadata = {
              guaranteeId: row.id,
              type: row.type,
              referenceNumber: row.referenceNumber,
              expiryDate: expiry,
            };
            if (row.contractId !== null) {
              await appendContractEvent(tx, c.organizationId, row.contractId, 'guarantee.expired', null, metadata);
              await refreshContract(tx, c.organizationId, row.contractId, c.today);
            } else if (row.tenderId !== null) {
              await appendTenderEvent(tx, c.organizationId, row.tenderId, 'guarantee.expired', null, metadata);
            }
            await recordAudit(tx, c.organizationId, {
              action: 'guarantee.expired',
              entityType: 'guarantee',
              entityId: row.id,
              actor: SYSTEM,
              metadata: { expiryDate: expiry },
            });
            if (
              await this.claim(tx, c.organizationId, {
                entityType: 'GUARANTEE',
                entityId: row.id,
                kind: 'EXPIRED',
                thresholdDays: 0,
                dueOn: expiry,
              })
            ) {
              const parent = await parentLabel(tx);
              await parent?.notify({
                type: 'GUARANTEE_EXPIRED',
                severity: 'CRITICAL',
                params: { parentKey: parent.key, guaranteeType: row.type, expiryDate: expiry },
                dedupeKey: `GUARANTEE_EXPIRED:${row.id}:${expiry}`,
                email: true,
              });
            }
            return true;
          });
          if (done) expired += 1;
          return;
        }
        const threshold = dueReminderThreshold(expiry, thresholds, c.now, c.timeZone);
        if (threshold === null) return;
        reminders += await this.remind(
          c,
          { entityType: 'GUARANTEE', entityId: row.id, kind: 'EXPIRY', thresholdDays: threshold, dueOn: expiry },
          async (tx) => {
            const parent = await parentLabel(tx);
            await parent?.notify({
              type: 'GUARANTEE_EXPIRING',
              severity: threshold <= 7 ? 'WARNING' : 'INFO',
              params: { parentKey: parent.key, guaranteeType: row.type, expiryDate: expiry, days: threshold },
              dedupeKey: `GUARANTEE_EXPIRING:${row.id}:${expiry}:${String(threshold)}`,
            });
          },
        );
      },
    );
    return { expired, reminders };
  }

  private async extendRecurrences(c: RunContext): Promise<number> {
    let generated = 0;
    const horizon = day(addDays(c.today, RECURRENCE_HORIZON_DAYS));
    await this.batches(
      (after) =>
        this.db.contractObligation.findMany({
          where: {
            organizationId: c.organizationId,
            recurrence: { not: 'NONE' },
            cancelledAt: null,
            AND: [
              { OR: [{ generatedThrough: null }, { generatedThrough: { lt: horizon } }] },
              // A finished series (generated through its end date) is not selected again.
              {
                OR: [
                  { recurrenceUntil: null },
                  { generatedThrough: null },
                  { generatedThrough: { lt: this.db.contractObligation.fields.recurrenceUntil } },
                ],
              },
            ],
            contract: { status: { in: [...MONITORED_CONTRACT_STATUSES] } },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: {
            id: true,
            contractId: true,
            recurrence: true,
            dueDate: true,
            recurrenceUntil: true,
            generatedThrough: true,
            ownerMemberId: true,
            cancelledAt: true,
          },
        }),
      async (row) => {
        generated += await this.db.$transaction(async (tx) => {
          await lockCommercialAggregate(tx, c.organizationId, 'contract', row.contractId);
          const inserted = await extendObligation(tx, c.organizationId, row, c.today);
          if (inserted > 0) await refreshContract(tx, c.organizationId, row.contractId, c.today);
          return inserted;
        });
      },
    );
    return generated;
  }

  private async dailyRefresh(c: RunContext): Promise<number> {
    const key: ReminderKey = {
      entityType: 'ORGANIZATION',
      entityId: c.organizationId,
      kind: 'HEALTH_REFRESH',
      thresholdDays: 0,
      dueOn: c.today,
    };
    const done = await this.db.commercialReminder.findFirst({
      where: {
        organizationId: c.organizationId,
        entityType: key.entityType,
        entityId: key.entityId,
        kind: key.kind,
        thresholdDays: 0,
        dueOn: day(c.today),
      },
      select: { id: true },
    });
    if (done !== null) return 0;
    let changed = 0;
    await this.batches(
      (after) =>
        this.db.contract.findMany({
          where: {
            organizationId: c.organizationId,
            status: { notIn: [...CLOSED_CONTRACT_STATUSES] },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: { id: true },
        }),
      async (row) => {
        const refresh = await this.db.$transaction(async (tx) => {
          await lockCommercialAggregate(tx, c.organizationId, 'contract', row.id);
          return refreshContract(tx, c.organizationId, row.id, c.today);
        });
        if (refresh.healthChanged || refresh.projectionChanged) changed += 1;
      },
    );
    await this.db.$transaction((tx) => this.claim(tx, c.organizationId, key));
    return changed;
  }

  // ---- reminders ----

  private async tenderDeadlines(c: RunContext, thresholds: readonly number[]): Promise<number> {
    let sent = 0;
    const until = new Date(c.now.getTime() + maxOf([...thresholds, LOW_READINESS_DAYS]) * 86_400_000);
    await this.batches(
      (after) =>
        this.db.tender.findMany({
          where: {
            organizationId: c.organizationId,
            status: { in: [...ACTIVE_TENDER_STATUSES] },
            submissionDeadlineAt: { gt: c.now, lte: until },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: {
            ...tenderAccessSelect,
            submissionDeadlineTimeZone: true,
            mandatoryApplicable: true,
            mandatoryApproved: true,
          },
        }),
      async (row) => {
        if (row.submissionDeadlineAt === null) return;
        const deadline = row.submissionDeadlineAt;
        const dueOn = localToday(deadline, row.submissionDeadlineTimeZone ?? c.timeZone);
        const params = {
          tenderKey: tenderKey(row.year, row.number),
          tenderTitle: row.title,
          deadline: deadline.toISOString(),
        };
        const recipients = [row.ownerMemberId, row.technicalLeadMemberId, row.commercialLeadMemberId];
        const threshold = deadlineReminderThreshold(deadline, thresholds, c.now);
        if (threshold !== null) {
          sent += await this.remind(
            c,
            { entityType: 'TENDER', entityId: row.id, kind: 'DEADLINE', thresholdDays: threshold, dueOn },
            (tx) =>
              this.notifyTender(tx, c, row, recipients, {
                type: 'TENDER_DEADLINE_APPROACHING',
                severity: threshold <= 3 ? 'WARNING' : 'INFO',
                params: { ...params, days: threshold },
                dedupeKey: `TENDER_DEADLINE_APPROACHING:${row.id}:${dueOn}:${String(threshold)}`,
                email: threshold <= 3,
              }),
          );
        }
        const lowReadiness =
          ['PREPARING', 'INTERNAL_REVIEW'].includes(row.status) &&
          readinessState(row) === 'NOT_READY' &&
          deadline.getTime() - c.now.getTime() <= LOW_READINESS_DAYS * 86_400_000;
        if (lowReadiness) {
          sent += await this.remind(
            c,
            { entityType: 'TENDER', entityId: row.id, kind: 'LOW_READINESS', thresholdDays: LOW_READINESS_DAYS, dueOn },
            (tx) =>
              this.notifyTender(tx, c, row, recipients, {
                type: 'TENDER_LOW_READINESS',
                severity: 'WARNING',
                params: { ...params, approved: row.mandatoryApproved, applicable: row.mandatoryApplicable },
                dedupeKey: `TENDER_LOW_READINESS:${row.id}:${dueOn}`,
                email: true,
              }),
          );
        }
      },
    );
    return sent;
  }

  private async requirementDeadlines(c: RunContext, thresholds: readonly number[]): Promise<number> {
    let sent = 0;
    const horizon = day(addDays(c.today, maxOf(thresholds)));
    await this.batches(
      (after) =>
        this.db.tenderRequirement.findMany({
          where: {
            organizationId: c.organizationId,
            status: OPEN_REQUIREMENT,
            ownerMemberId: { not: null },
            dueDate: { lte: horizon },
            tender: { status: { in: [...ACTIVE_TENDER_STATUSES] } },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: { id: true, title: true, dueDate: true, ownerMemberId: true, tender: { select: tenderAccessSelect } },
        }),
      async (row) => {
        const due = dateOnly(row.dueDate);
        if (due === null) return;
        const overdue = due < c.today;
        const threshold = overdue ? 0 : dueReminderThreshold(due, thresholds, c.now, c.timeZone);
        if (threshold === null) return;
        const kind = overdue ? 'OVERDUE' : 'DUE_SOON';
        sent += await this.remind(
          c,
          { entityType: 'TENDER_REQUIREMENT', entityId: row.id, kind, thresholdDays: threshold, dueOn: due },
          (tx) =>
            this.notifyTender(tx, c, row.tender, [row.ownerMemberId], {
              type: overdue ? 'TENDER_REQUIREMENT_OVERDUE' : 'TENDER_REQUIREMENT_DUE_SOON',
              severity: overdue ? 'WARNING' : 'INFO',
              params: {
                tenderKey: tenderKey(row.tender.year, row.tender.number),
                tenderTitle: row.tender.title,
                requirementTitle: row.title,
                dueDate: due,
                days: overdue ? daysBetween(due, c.today) : threshold,
              },
              dedupeKey: `TENDER_REQUIREMENT_${kind}:${row.id}:${due}:${String(threshold)}`,
            }),
        );
      },
    );
    return sent;
  }

  private async corporateDocuments(c: RunContext, thresholds: readonly number[]): Promise<number> {
    let sent = 0;
    const horizon = day(addDays(c.today, maxOf(thresholds)));
    let managers: string[] | null = null;
    await this.batches(
      (after) =>
        this.db.corporateDocument.findMany({
          where: {
            organizationId: c.organizationId,
            status: 'ACTIVE',
            currentExpiryDate: { lte: horizon },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: { ...corporateAccessSelect, title: true, documentType: true, currentExpiryDate: true },
        }),
      async (row) => {
        const expiry = dateOnly(row.currentExpiryDate);
        if (expiry === null) return;
        const expired = expiry < c.today;
        const threshold = expired ? 0 : dueReminderThreshold(expiry, thresholds, c.now, c.timeZone);
        if (threshold === null) return;
        const kind = expired ? 'EXPIRED' : 'EXPIRING';
        const facts = corporateFacts(c.organizationId, row);
        sent += await this.remind(
          c,
          { entityType: 'CORPORATE_DOCUMENT', entityId: row.id, kind, thresholdDays: threshold, dueOn: expiry },
          async (tx) => {
            managers ??= await permissionHolderIds(tx, c.organizationId, 'corporate_document.manage');
            const recipients = row.ownerMemberId === null ? managers : [row.ownerMemberId];
            await notifyMembers(
              tx,
              c.organizationId,
              recipients,
              {
                type: expired ? 'CORPORATE_DOCUMENT_EXPIRED' : 'CORPORATE_DOCUMENT_EXPIRING',
                severity: expired ? 'CRITICAL' : threshold <= 14 ? 'WARNING' : 'INFO',
                entityType: 'corporate_document',
                entityId: row.id,
                params: {
                  documentTitle: row.title,
                  documentType: row.documentType,
                  expiryDate: expiry,
                  days: threshold,
                },
                dedupeKey: `CORPORATE_DOCUMENT_${kind}:${row.id}:${expiry}:${String(threshold)}`,
                email: expired || threshold <= 30,
              },
              (principal) => canViewCorporate(principal, facts, row.classification),
              null,
            );
          },
        );
      },
    );
    return sent;
  }

  private async contractDates(c: RunContext, thresholds: readonly number[]): Promise<number> {
    let sent = 0;
    const horizon = day(addDays(c.today, maxOf(thresholds)));
    const todayDate = day(c.today);
    await this.batches(
      (after) =>
        this.db.contract.findMany({
          where: {
            organizationId: c.organizationId,
            status: { in: [...LIVE_CONTRACT_STATUSES] },
            OR: [
              { currentExpiryDate: { gte: todayDate, lte: horizon } },
              { renewalDecision: null, renewalDecisionDate: { gte: todayDate, lte: horizon } },
              {
                renewalDecision: null,
                renewalType: { in: ['MANUAL_RENEWAL', 'AUTO_RENEWAL', 'EVERGREEN'] },
                renewalNoticeDeadline: { gte: todayDate, lte: horizon },
              },
            ],
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: {
            ...contractAccessSelect,
            renewalType: true,
            renewalDecision: true,
            currentExpiryDate: true,
            renewalDecisionDate: true,
            renewalNoticeDeadline: true,
          },
        }),
      async (row) => {
        const base = { contractKey: contractKey(row.year, row.number), contractTitle: row.title };
        const dates: { kind: string; type: string; date: string | null; applies: boolean }[] = [
          { kind: 'EXPIRY', type: 'CONTRACT_EXPIRY_APPROACHING', date: dateOnly(row.currentExpiryDate), applies: true },
          {
            kind: 'RENEWAL_DECISION',
            type: 'CONTRACT_RENEWAL_DECISION_DUE',
            date: dateOnly(row.renewalDecisionDate),
            applies: row.renewalDecision === null,
          },
          {
            kind: 'NOTICE_DEADLINE',
            type: 'CONTRACT_NOTICE_DEADLINE_APPROACHING',
            date: dateOnly(row.renewalNoticeDeadline),
            applies: row.renewalDecision === null && row.renewalType !== 'NONE' && row.renewalType !== 'FIXED_TERM',
          },
        ];
        for (const entry of dates) {
          if (!entry.applies || entry.date === null || entry.date < c.today) continue;
          const date = entry.date;
          const threshold = dueReminderThreshold(date, thresholds, c.now, c.timeZone);
          if (threshold === null) continue;
          sent += await this.remind(
            c,
            { entityType: 'CONTRACT', entityId: row.id, kind: entry.kind, thresholdDays: threshold, dueOn: date },
            (tx) =>
              this.notifyContract(tx, c, row, [row.ownerMemberId], {
                type: entry.type,
                severity: threshold <= 14 ? 'WARNING' : 'INFO',
                params: { ...base, date, days: threshold },
                dedupeKey: `${entry.type}:${row.id}:${date}:${String(threshold)}`,
                email: threshold <= 30,
              }),
          );
        }
      },
    );
    return sent;
  }

  private async occurrences(c: RunContext, thresholds: readonly number[]): Promise<number> {
    let sent = 0;
    const horizon = day(addDays(c.today, maxOf(thresholds)));
    await this.batches(
      (after) =>
        this.db.contractObligationOccurrence.findMany({
          where: {
            organizationId: c.organizationId,
            status: { in: ['UPCOMING', 'IN_PROGRESS'] },
            dueDate: { lte: horizon },
            contract: { status: { in: [...MONITORED_CONTRACT_STATUSES] } },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: {
            id: true,
            dueDate: true,
            ownerMemberId: true,
            obligation: { select: { title: true, criticality: true, ownerMemberId: true } },
            contract: { select: contractAccessSelect },
          },
        }),
      async (row) => {
        const due = dateOnly(row.dueDate) ?? c.today;
        const overdue = due < c.today;
        const threshold = overdue ? 0 : dueReminderThreshold(due, thresholds, c.now, c.timeZone);
        if (threshold === null) return;
        const kind = overdue ? 'OVERDUE' : 'DUE_SOON';
        const owner = row.ownerMemberId ?? row.obligation.ownerMemberId ?? row.contract.ownerMemberId;
        const critical = row.obligation.criticality === 'CRITICAL';
        const recipients = overdue && critical ? [owner, row.contract.ownerMemberId] : [owner];
        sent += await this.remind(
          c,
          { entityType: 'OBLIGATION_OCCURRENCE', entityId: row.id, kind, thresholdDays: threshold, dueOn: due },
          (tx) =>
            this.notifyContract(tx, c, row.contract, recipients, {
              type: overdue ? 'CONTRACT_OBLIGATION_OVERDUE' : 'CONTRACT_OBLIGATION_DUE_SOON',
              severity: overdue ? (critical ? 'CRITICAL' : 'WARNING') : 'INFO',
              params: {
                contractKey: contractKey(row.contract.year, row.contract.number),
                contractTitle: row.contract.title,
                obligationTitle: row.obligation.title,
                dueDate: due,
                days: overdue ? daysBetween(due, c.today) : threshold,
              },
              dedupeKey: `CONTRACT_OBLIGATION_${kind}:${row.id}:${due}:${String(threshold)}`,
              email: overdue,
            }),
        );
      },
    );
    return sent;
  }

  private async milestones(c: RunContext, thresholds: readonly number[]): Promise<number> {
    let sent = 0;
    const horizon = day(addDays(c.today, maxOf(thresholds)));
    await this.batches(
      (after) =>
        this.db.contractMilestone.findMany({
          where: {
            organizationId: c.organizationId,
            status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
            dueDate: { lte: horizon },
            contract: { status: { in: [...MONITORED_CONTRACT_STATUSES] } },
            ...(after === null ? {} : { id: { gt: after } }),
          },
          orderBy: { id: 'asc' },
          take: COMMERCIAL_MONITOR_BATCH_SIZE,
          select: {
            id: true,
            title: true,
            dueDate: true,
            ownerMemberId: true,
            contract: { select: contractAccessSelect },
          },
        }),
      async (row) => {
        const due = dateOnly(row.dueDate) ?? c.today;
        const overdue = due < c.today;
        const threshold = overdue ? 0 : dueReminderThreshold(due, thresholds, c.now, c.timeZone);
        if (threshold === null) return;
        const kind = overdue ? 'OVERDUE' : 'DUE_SOON';
        sent += await this.remind(
          c,
          { entityType: 'CONTRACT_MILESTONE', entityId: row.id, kind, thresholdDays: threshold, dueOn: due },
          (tx) =>
            this.notifyContract(tx, c, row.contract, [row.ownerMemberId ?? row.contract.ownerMemberId], {
              type: overdue ? 'CONTRACT_MILESTONE_OVERDUE' : 'CONTRACT_MILESTONE_DUE_SOON',
              severity: overdue ? 'WARNING' : 'INFO',
              params: {
                contractKey: contractKey(row.contract.year, row.contract.number),
                contractTitle: row.contract.title,
                milestoneTitle: row.title,
                dueDate: due,
                days: overdue ? daysBetween(due, c.today) : threshold,
              },
              dedupeKey: `CONTRACT_MILESTONE_${kind}:${row.id}:${due}:${String(threshold)}`,
            }),
        );
      },
    );
    return sent;
  }
}
