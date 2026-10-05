import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AmendmentService } from '../../src/modules/commercial/amendment.service.js';
import { CommercialDocumentService } from '../../src/modules/commercial/commercial-document.service.js';
import { CommercialMonitor } from '../../src/modules/commercial/commercial-monitor.js';
import { ContractWorkService } from '../../src/modules/commercial/contract-work.service.js';
import { ContractService } from '../../src/modules/commercial/contract.service.js';
import { CorporateDocumentService } from '../../src/modules/commercial/corporate-document.service.js';
import { GuaranteeService } from '../../src/modules/commercial/guarantee.service.js';
import { TenderRequirementService } from '../../src/modules/commercial/tender-requirement.service.js';
import { TenderReviewService } from '../../src/modules/commercial/tender-review.service.js';
import { TenderService } from '../../src/modules/commercial/tender.service.js';
import { ForbiddenError, InvalidTransitionError, NotFoundError } from '../../src/platform/errors.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Phase 10 domain rules against real PostgreSQL with the development seed: tenant isolation,
 * financial redaction, the requirement -> review -> submission -> award -> contract chain with
 * idempotent replays, amendment four-eyes and projection, requirement attachment access, and the
 * commercial monitor (calendar-driven expiry, reminders claimed once, harmless re-runs).
 */
let s: SeededDatabase;
let tenders: TenderService;
let requirements: TenderRequirementService;
let reviews: TenderReviewService;
let contracts: ContractService;
let work: ContractWorkService;
let guarantees: GuaranteeService;
let amendments: AmendmentService;
let ihdProject: string;

const isoDate = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const inDays = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString();
const CRITERIA = {
  technicalFit: 'YES',
  commercialAttractiveness: 'YES',
  resourcesAvailable: 'YES',
  requiredQualificationsAvailable: 'YES',
  deadlineFeasible: 'YES',
  strategicCustomer: 'NOT_EVALUATED',
  previousExperienceAvailable: 'YES',
  commercialRisk: 'NO',
  technicalRisk: 'NO',
} as const;

beforeAll(async () => {
  s = await startSeededDatabase();
  tenders = new TenderService(s.tenantDb, s.tenant);
  requirements = new TenderRequirementService(s.tenantDb, s.tenant);
  reviews = new TenderReviewService(s.tenantDb, s.tenant);
  contracts = new ContractService(s.tenantDb, s.tenant);
  work = new ContractWorkService(s.tenantDb, s.tenant);
  guarantees = new GuaranteeService(s.tenantDb, s.tenant);
  amendments = new AmendmentService(s.tenantDb, s.tenant);
  ihdProject = (
    await s.prisma.project.findFirstOrThrow({ where: { organizationId: s.demoId, code: 'IHD' }, select: { id: true } })
  ).id;
}, 300_000);

afterAll(async () => {
  await s.stop();
});

describe('tender to contract', () => {
  it('runs requirement, review, submission and award gates and replays idempotent actions once', async () => {
    const gm = await s.actionFor('EMP-00002');
    const owner = await s.actionFor('EMP-00004');
    const field = await s.actionFor('EMP-00031');
    const pm = await s.actionFor('EMP-00041');

    const created = await s.as(gm, () =>
      tenders.create(gm, {
        title: 'Traffic sensors phase 2',
        tenderType: 'OPEN_TENDER',
        ownerMemberId: gm.principal.memberId,
        status: 'NEW',
        submissionDeadlineAt: inDays(25),
        submissionDeadlineTimeZone: 'Africa/Cairo',
        estimatedValue: '900000.00',
        currency: 'EGP',
        relatedProjectId: ihdProject,
      }),
    );
    expect(created.key).toMatch(/^TND-\d{4}-\d{4}$/);

    // Project-scoped access without the financial permission never sees the value; no access is 404.
    const scoped = await s.as(pm, () => tenders.get(pm, created.id));
    expect(scoped.estimatedValue).toBeUndefined();
    expect(JSON.stringify(scoped)).not.toContain('900000');
    await expect(s.as(field, () => tenders.get(field, created.id))).rejects.toBeInstanceOf(NotFoundError);

    const preparing = await s.as(gm, () =>
      tenders.decideBid(gm, created.id, { version: created.version, decision: 'BID', criteria: CRITERIA }),
    );
    expect(preparing.status).toBe('PREPARING');

    const requirement = await s.as(gm, () =>
      requirements.create(gm, created.id, {
        category: 'TECHNICAL',
        title: 'Compliance matrix',
        ownerMemberId: owner.principal.memberId,
        reviewerMemberId: gm.principal.memberId,
        mandatory: true,
        dueDate: isoDate(10),
      }),
    );
    // A review cannot start before every applicable mandatory requirement is approved.
    const notReady = await s.as(gm, () => tenders.get(gm, created.id));
    await expect(
      s.as(gm, () =>
        reviews.request(gm, created.id, {
          version: notReady.version,
          gates: [{ gate: 'FINAL', mode: 'ANY_ONE', reviewerMemberIds: [gm.principal.memberId] }],
        }),
      ),
    ).rejects.toThrow(/mandatory requirement/);

    // Owners cannot approve their own work; the reviewer can once it is ready for review.
    const started = await s.as(owner, () =>
      requirements.changeStatus(owner, created.id, requirement.id, {
        version: requirement.version,
        status: 'READY_FOR_REVIEW',
      }),
    );
    await expect(
      s.as(owner, () =>
        requirements.changeStatus(owner, created.id, requirement.id, { version: started.version, status: 'APPROVED' }),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
    const approved = await s.as(gm, () =>
      requirements.changeStatus(gm, created.id, requirement.id, { version: started.version, status: 'APPROVED' }),
    );
    expect(approved.status).toBe('APPROVED');

    // Requirement attachments follow the tender: the owner reads them, an outsider gets nothing.
    expect((await s.as(owner, () => requirements.attachmentAccess(owner, requirement.id))).canView).toBe(true);
    expect(await s.as(field, () => requirements.attachmentAccess(field, requirement.id))).toEqual({
      canView: false,
      canUpload: false,
      canDelete: false,
    });

    const ready = await s.as(gm, () => tenders.get(gm, created.id));
    expect(ready.readiness).toMatchObject({ state: 'READY', percent: 100 });
    const gates = await s.as(gm, () =>
      reviews.request(gm, created.id, {
        version: ready.version,
        gates: [{ gate: 'FINAL', mode: 'ANY_ONE', reviewerMemberIds: [gm.principal.memberId] }],
      }),
    );
    const finalReview = gates[0]?.reviews[0];
    expect(finalReview).toBeDefined();
    await s.as(gm, () => reviews.decide(gm, created.id, finalReview?.id ?? '', { decision: 'APPROVED' }));
    const readyToSubmit = await s.as(gm, () => tenders.get(gm, created.id));
    expect(readyToSubmit.status).toBe('READY_FOR_SUBMISSION');

    // Submission evidence: a confidential proposal version.
    const documents = new CommercialDocumentService(s.tenantDb, s.tenant);
    const proposal = await s.as(gm, () =>
      documents.createForTender(gm, created.id, { category: 'COMMERCIAL_SUBMISSION', title: 'Priced proposal' }),
    );
    const proposalFile = await s.prisma.attachment.create({
      data: {
        organizationId: s.demoId,
        ownerType: 'COMMERCIAL_DOCUMENT',
        ownerId: proposal.id,
        storageKey: `org/${s.demoId}/COMMERCIAL_DOCUMENT/${randomUUID()}`,
        originalFilename: 'proposal.pdf',
        declaredContentType: 'application/pdf',
        declaredSizeBytes: 64,
        contentType: 'application/pdf',
        sizeBytes: 64,
        checksumSha256: 'c'.repeat(64),
        status: 'AVAILABLE',
        uploadedByMemberId: gm.principal.memberId,
        uploadExpiresAt: inDays(1),
        completedAt: new Date(),
      },
    });
    const proposalVersion = (
      await s.as(gm, () => documents.addVersion(gm, proposal.id, { attachmentId: proposalFile.id }))
    ).versions[0]?.id;

    const submissionKey = randomUUID();
    const submission = {
      version: readyToSubmit.version,
      method: 'GOVERNMENT_PORTAL',
      submittedAt: new Date().toISOString(),
      evidenceVersionId: proposalVersion ?? null,
    } as const;
    const submitted = await s.as(gm, () => tenders.submit(gm, created.id, submission, submissionKey));
    const replayed = await s.as(gm, () => tenders.submit(gm, created.id, submission, submissionKey));
    expect(submitted.status).toBe('SUBMITTED');
    expect(replayed.version).toBe(submitted.version);
    const recorded = await s.as(gm, () => tenders.listSubmissions(gm, created.id));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.evidence?.title).toBe('Priced proposal');
    // The project manager sees the submission but not that confidential evidence exists.
    const scopedSubmissions = await s.as(pm, () => tenders.listSubmissions(pm, created.id));
    expect(scopedSubmissions).toHaveLength(1);
    expect(scopedSubmissions[0]?.evidence).toBeNull();
    expect(JSON.stringify(scopedSubmissions)).not.toContain('Priced proposal');

    const awarded = await s.as(gm, () =>
      tenders.recordAward(gm, created.id, {
        version: submitted.version,
        awardDate: isoDate(0),
        awardValue: '880000.00',
        awardCurrency: 'EGP',
      }),
    );
    expect(awarded.status).toBe('AWARDED');

    const conversionKey = randomUUID();
    const contract = await s.as(gm, () =>
      contracts.createFromTender(
        gm,
        created.id,
        { contractType: 'SUPPLY', startDate: isoDate(0), expiryDate: isoDate(365) },
        conversionKey,
      ),
    );
    const again = await s.as(gm, () =>
      contracts.createFromTender(
        gm,
        created.id,
        { contractType: 'SUPPLY', startDate: isoDate(0), expiryDate: isoDate(365) },
        conversionKey,
      ),
    );
    expect(again.id).toBe(contract.id);
    expect(contract).toMatchObject({ status: 'DRAFT', currentValue: { amount: '880000', currency: 'EGP' } });
    expect(await s.prisma.contract.count({ where: { organizationId: s.demoId, sourceTenderId: created.id } })).toBe(1);
  });

  it('never reads or writes another organization’s tenders', async () => {
    const gm = await s.actionFor('EMP-00002');
    const foreignOwner = await s.prisma.organizationMember.findFirstOrThrow({
      where: { organizationId: s.northwindId },
      select: { id: true },
    });
    const foreign = await s.prisma.tender.create({
      data: {
        organizationId: s.northwindId,
        number: 900,
        year: 2026,
        title: 'Northwind confidential bid',
        tenderType: 'RFQ',
        ownerMemberId: foreignOwner.id,
        createdByMemberId: foreignOwner.id,
      },
    });
    await expect(s.as(gm, () => tenders.get(gm, foreign.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      s.as(gm, () => requirements.create(gm, foreign.id, { category: 'LEGAL', title: 'Cross-tenant write' })),
    ).rejects.toBeInstanceOf(NotFoundError);
    const page = await s.as(gm, () => tenders.list(gm, { includeArchived: true, limit: 100 }));
    expect(page.items.map((tender) => tender.id)).not.toContain(foreign.id);
    expect(await s.prisma.tenderRequirement.count({ where: { tenderId: foreign.id } })).toBe(0);
  });
});

describe('corporate vault', () => {
  it('lists the tender requirements that use a document to readers of those tenders only', async () => {
    const gm = await s.actionFor('EMP-00002');
    const owner = await s.actionFor('EMP-00004');
    const field = await s.actionFor('EMP-00031');
    const vault = new CorporateDocumentService(s.tenantDb, s.tenant);
    const document = await s.as(gm, () =>
      vault.create(gm, { documentType: 'COMMERCIAL_REGISTRATION', title: 'Commercial registration (vault test)' }),
    );
    const attachment = await s.prisma.attachment.create({
      data: {
        organizationId: s.demoId,
        ownerType: 'CORPORATE_DOCUMENT',
        ownerId: document.id,
        storageKey: `org/${s.demoId}/CORPORATE_DOCUMENT/${randomUUID()}`,
        originalFilename: 'registration.pdf',
        declaredContentType: 'application/pdf',
        declaredSizeBytes: 64,
        contentType: 'application/pdf',
        sizeBytes: 64,
        checksumSha256: 'a'.repeat(64),
        status: 'AVAILABLE',
        uploadedByMemberId: gm.principal.memberId,
        uploadExpiresAt: inDays(1),
        completedAt: new Date(),
      },
    });
    const versioned = await s.as(gm, () => vault.addVersion(gm, document.id, { attachmentId: attachment.id }));
    const version = versioned.versions.find((row) => row.isCurrent);
    expect(version).toBeDefined();
    const tender = await s.as(gm, () =>
      tenders.create(gm, {
        title: 'Vault link tender',
        tenderType: 'RFQ',
        ownerMemberId: gm.principal.memberId,
        status: 'NEW',
        submissionDeadlineAt: inDays(20),
        submissionDeadlineTimeZone: 'Africa/Cairo',
      }),
    );
    const requirement = await s.as(gm, () =>
      requirements.create(gm, tender.id, {
        category: 'ADMINISTRATIVE',
        title: 'Valid registration',
        ownerMemberId: owner.principal.memberId,
        mandatory: true,
      }),
    );
    await s.as(gm, () =>
      requirements.addLink(gm, tender.id, requirement.id, { corporateDocumentVersionId: version?.id ?? '' }),
    );

    const detail = await s.as(gm, () => vault.get(gm, document.id));
    expect(detail.linkedRequirements).toEqual([
      expect.objectContaining({ versionNumber: 1, requirement: { id: requirement.id, title: 'Valid registration' } }),
    ]);
    expect(detail.linkedRequirements[0]?.tender.id).toBe(tender.id);
    // HR reads the vault but not tenders: the document, without the tender usage.
    const hr = await s.actionFor('EMP-00003');
    expect((await s.as(hr, () => vault.get(hr, document.id))).linkedRequirements).toEqual([]);
    // The vault itself stays behind its permission for members without it.
    await expect(s.as(field, () => vault.get(field, document.id))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('amendments', () => {
  it('needs a second approver and moves the projection only when the amendment becomes effective', async () => {
    const gm = await s.actionFor('EMP-00002');
    const manager = await s.employee('EMP-00032');
    const gmRole = await s.prisma.role.findFirstOrThrow({
      where: { organizationId: s.demoId, key: 'GENERAL_MANAGER' },
      select: { id: true },
    });
    await s.prisma.memberRole.create({
      data: { organizationId: s.demoId, memberId: manager.memberId, roleId: gmRole.id },
    });
    const author = await s.actionFor('EMP-00032');

    const draft = await s.as(gm, () =>
      contracts.create(gm, {
        title: 'Fibre maintenance',
        contractType: 'MAINTENANCE',
        currency: 'EGP',
        originalValue: '100000.00',
        startDate: isoDate(-30),
        expiryDate: isoDate(300),
        ownerMemberId: gm.principal.memberId,
      }),
    );
    let version = draft.version;
    for (const to of ['UNDER_REVIEW', 'AWAITING_SIGNATURE', 'ACTIVE'] as const) {
      version = (await s.as(gm, () => contracts.transition(gm, draft.id, { version, to }))).version;
    }

    const amendment = await s.as(author, () =>
      amendments.create(author, draft.id, {
        type: 'COMMERCIAL_CHANGE',
        title: 'Extra districts',
        effectiveDate: isoDate(0),
        valueDelta: '25000.50',
        newExpiryDate: isoDate(400),
      }),
    );
    const submitted = await s.as(author, () =>
      amendments.act(author, draft.id, amendment.id, { version: amendment.version, action: 'SUBMIT' }),
    );
    await expect(
      s.as(author, () =>
        amendments.act(author, draft.id, amendment.id, { version: submitted.version, action: 'APPROVE' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const approved = await s.as(gm, () =>
      amendments.act(gm, draft.id, amendment.id, { version: submitted.version, action: 'APPROVE' }),
    );
    const beforeEffective = await s.as(gm, () => contracts.get(gm, draft.id));
    expect(beforeEffective.currentValue).toEqual({ amount: '100000', currency: 'EGP' });

    await s.as(author, () =>
      amendments.act(author, draft.id, amendment.id, { version: approved.version, action: 'ACTIVATE' }),
    );
    const after = await s.as(gm, () => contracts.get(gm, draft.id));
    expect(after.currentValue).toEqual({ amount: '125000.5', currency: 'EGP' });
    expect(after.originalValue).toEqual({ amount: '100000', currency: 'EGP' });
    expect(after.currentExpiryDate).toBe(isoDate(400));
  });

  it('reactivates an expired contract and records the value and expiry changes of the amendment', async () => {
    const gm = await s.actionFor('EMP-00002');
    const author = await s.actionFor('EMP-00006');
    const draft = await s.as(gm, () =>
      contracts.create(gm, {
        title: 'Lapsed radio support',
        contractType: 'SUPPORT',
        currency: 'EGP',
        originalValue: '50000.00',
        startDate: isoDate(-60),
        expiryDate: isoDate(10),
        ownerMemberId: gm.principal.memberId,
      }),
    );
    let version = draft.version;
    for (const to of ['UNDER_REVIEW', 'AWAITING_SIGNATURE', 'ACTIVE', 'EXPIRED'] as const) {
      version = (await s.as(gm, () => contracts.transition(gm, draft.id, { version, to }))).version;
    }

    const amendment = await s.as(author, () =>
      amendments.create(author, draft.id, {
        type: 'TIME_EXTENSION',
        title: 'Second year',
        effectiveDate: isoDate(0),
        valueDelta: '12000.00',
        newExpiryDate: isoDate(200),
      }),
    );
    const submitted = await s.as(author, () =>
      amendments.act(author, draft.id, amendment.id, { version: amendment.version, action: 'SUBMIT' }),
    );
    const approved = await s.as(gm, () =>
      amendments.act(gm, draft.id, amendment.id, { version: submitted.version, action: 'APPROVE' }),
    );
    await s.as(author, () =>
      amendments.act(author, draft.id, amendment.id, { version: approved.version, action: 'ACTIVATE' }),
    );

    const after = await s.as(gm, () => contracts.get(gm, draft.id));
    expect(after.status).toBe('ACTIVE');
    expect(after.currentValue).toEqual({ amount: '62000', currency: 'EGP' });
    expect(after.currentExpiryDate).toBe(isoDate(200));
    const events = await s.prisma.contractEvent.findMany({
      where: {
        organizationId: s.demoId,
        contractId: draft.id,
        type: { in: ['contract.value_changed', 'contract.expiry_changed'] },
      },
      select: { type: true, metadata: true },
    });
    expect(events.map((event) => event.type).sort()).toEqual(['contract.expiry_changed', 'contract.value_changed']);
    expect(events.find((event) => event.type === 'contract.expiry_changed')?.metadata).toMatchObject({
      previousExpiryDate: isoDate(10),
      currentExpiryDate: isoDate(200),
    });
  });
});

describe('commercial monitor', () => {
  it('expires by the calendar, reminds once per threshold and is harmless to re-run', async () => {
    const gm = await s.actionFor('EMP-00002');
    const owner = await s.actionFor('EMP-00004');
    const activate = async (contractId: string, initial: number): Promise<void> => {
      let version = initial;
      for (const to of ['UNDER_REVIEW', 'AWAITING_SIGNATURE', 'ACTIVE'] as const) {
        version = (await s.as(gm, () => contracts.transition(gm, contractId, { version, to }))).version;
      }
    };

    const lapsing = await s.as(gm, () =>
      contracts.create(gm, {
        title: 'Lapsed hosting',
        contractType: 'SUPPORT',
        currency: 'EGP',
        originalValue: '1000.00',
        startDate: isoDate(-400),
        expiryDate: isoDate(200),
        ownerMemberId: gm.principal.memberId,
      }),
    );
    await activate(lapsing.id, lapsing.version);
    await s.prisma.contract.update({
      where: { id: lapsing.id },
      data: {
        originalExpiryDate: new Date(`${isoDate(-2)}T00:00:00Z`),
        currentExpiryDate: new Date(`${isoDate(-2)}T00:00:00Z`),
      },
    });

    const live = await s.as(gm, () =>
      contracts.create(gm, {
        title: 'Expiring support',
        contractType: 'SUPPORT',
        currency: 'EGP',
        originalValue: '2000.00',
        startDate: isoDate(-100),
        expiryDate: isoDate(45),
        renewalType: 'MANUAL_RENEWAL',
        ownerMemberId: gm.principal.memberId,
      }),
    );
    await activate(live.id, live.version);
    await s.as(gm, () =>
      work.createObligation(gm, live.id, {
        title: 'Monthly availability report',
        category: 'REPORTING',
        ownerMemberId: owner.principal.memberId,
        recurrence: 'MONTHLY',
        dueDate: isoDate(3),
      }),
    );
    const expiring = await s.as(gm, () =>
      guarantees.createForContract(gm, live.id, {
        type: 'PERFORMANCE_GUARANTEE',
        referenceNumber: 'PG-MON-1',
        issuer: 'National Bank',
        issueDate: isoDate(-30),
        expiryDate: isoDate(10),
      }),
    );
    const lapsed = await s.as(gm, () =>
      guarantees.createForContract(gm, live.id, {
        type: 'ADVANCE_PAYMENT_GUARANTEE',
        referenceNumber: 'PG-MON-2',
        issuer: 'National Bank',
        issueDate: isoDate(-60),
        expiryDate: isoDate(20),
      }),
    );
    await s.prisma.guarantee.update({
      where: { id: lapsed.id },
      data: { expiryDate: new Date(`${isoDate(-1)}T00:00:00Z`) },
    });

    const monitor = new CommercialMonitor(s.tenantDb, s.tenant);
    const now = new Date();
    const first = await s.asSystem(s.demoId, () => monitor.run(now));
    expect(first.contractsExpired).toBeGreaterThanOrEqual(1);
    expect(first.guaranteesExpired).toBeGreaterThanOrEqual(1);
    expect(first.reminders).toBeGreaterThanOrEqual(3);

    expect((await s.prisma.contract.findUniqueOrThrow({ where: { id: lapsing.id } })).status).toBe('EXPIRED');
    expect((await s.prisma.guarantee.findUniqueOrThrow({ where: { id: lapsed.id } })).status).toBe('EXPIRED');
    expect((await s.prisma.guarantee.findUniqueOrThrow({ where: { id: expiring.id } })).status).toBe('ACTIVE');
    const reminderKinds = await s.prisma.commercialReminder.findMany({
      where: { organizationId: s.demoId, entityId: { in: [live.id, expiring.id] } },
      select: { entityId: true, thresholdDays: true },
    });
    expect(reminderKinds).toEqual(
      expect.arrayContaining([
        { entityId: live.id, thresholdDays: 60 },
        { entityId: expiring.id, thresholdDays: 14 },
      ]),
    );

    const remindersAfterFirst = await s.prisma.commercialReminder.count({ where: { organizationId: s.demoId } });
    const notificationsAfterFirst = await s.prisma.notification.count({ where: { organizationId: s.demoId } });
    const second = await s.asSystem(s.demoId, () => monitor.run(now));
    expect(second).toMatchObject({ reminders: 0, contractsExpired: 0, guaranteesExpired: 0, occurrencesGenerated: 0 });
    expect(await s.prisma.commercialReminder.count({ where: { organizationId: s.demoId } })).toBe(remindersAfterFirst);
    expect(await s.prisma.notification.count({ where: { organizationId: s.demoId } })).toBe(notificationsAfterFirst);

    // Concurrent passes (two workers) still claim each reminder once.
    const later = new Date(now.getTime() + 8 * 86_400_000);
    const [left, right] = await Promise.all([
      s.asSystem(s.demoId, () => monitor.run(later)),
      s.asSystem(s.demoId, () => monitor.run(later)),
    ]);
    expect(left.reminders + right.reminders).toBeGreaterThan(0);
    const claims = await s.prisma.commercialReminder.groupBy({
      by: ['entityType', 'entityId', 'kind', 'thresholdDays', 'dueOn'],
      where: { organizationId: s.demoId },
      _count: { _all: true },
    });
    expect(claims.every((claim) => claim._count._all === 1)).toBe(true);
    expect((await s.asSystem(s.demoId, () => monitor.run(later))).reminders).toBe(0);

    // The monitor never touches another organization's records.
    expect(await s.prisma.commercialReminder.count({ where: { organizationId: s.northwindId } })).toBe(0);
  });
});
