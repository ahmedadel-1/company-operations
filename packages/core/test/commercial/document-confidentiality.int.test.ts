import { randomUUID } from 'node:crypto';

import { commercialReportSchema } from '@company-ops/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionContext } from '../../src/modules/action-context.js';
import { AmendmentService } from '../../src/modules/commercial/amendment.service.js';
import { CommercialDocumentService } from '../../src/modules/commercial/commercial-document.service.js';
import { ContractService } from '../../src/modules/commercial/contract.service.js';
import { CorporateDocumentService } from '../../src/modules/commercial/corporate-document.service.js';
import { TenderRequirementService } from '../../src/modules/commercial/tender-requirement.service.js';
import { TenderService } from '../../src/modules/commercial/tender.service.js';
import { DashboardCache, InMemoryDashboardCacheStore } from '../../src/modules/dashboard/dashboard-cache.js';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service.js';
import { NeedsAttentionService } from '../../src/modules/dashboard/needs-attention.service.js';
import { SearchService } from '../../src/modules/dashboard/search.service.js';
import { NotFoundError } from '../../src/platform/errors.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Restricted documents are invisible, not merely unreadable (ADR-0026 §7): for a caller without the
 * classification permission a hidden document contributes nothing to rows, pages, counts, search,
 * dashboards, Needs Attention, "used by", requirement links, timelines or version references.
 *
 * Actors: EMP-00002 general manager (every classification, both financial permissions); EMP-00003 HR
 * admin (vault view and manage, no restricted view); EMP-00041 project manager of IHD (tenders and
 * contracts of IHD, vault view, no `commercial_document.view`); NW-001 general manager of the second
 * organization.
 */
const RUN = randomUUID().slice(0, 8);
const MARK = `Conf${RUN}`;
const CLASSIFICATIONS = ['GENERAL', 'COMMERCIAL_CONFIDENTIAL', 'LEGAL_RESTRICTED', 'BANKING_RESTRICTED'] as const;
type Classification = (typeof CLASSIFICATIONS)[number];

let s: SeededDatabase;
let vault: CorporateDocumentService;
let documents: CommercialDocumentService;
let tenders: TenderService;
let requirements: TenderRequirementService;
let contracts: ContractService;
let amendments: AmendmentService;
let search: SearchService;
let gm: ActionContext;
let hr: ActionContext;
let pm: ActionContext;
let foreign: ActionContext;
let ihdProject: string;

/** Vault documents by id: three GENERAL (to page through) and one of each restricted class. */
const vaultDocs = new Map<string, Classification>();
const vaultVersions = new Map<Classification, string>();

const isoDate = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const inDays = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86_400_000).toISOString();

async function attachment(ownerType: 'CORPORATE_DOCUMENT' | 'COMMERCIAL_DOCUMENT', ownerId: string): Promise<string> {
  const row = await s.prisma.attachment.create({
    data: {
      organizationId: s.demoId,
      ownerType,
      ownerId,
      storageKey: `org/${s.demoId}/${ownerType}/${randomUUID()}`,
      originalFilename: 'evidence.pdf',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 64,
      contentType: 'application/pdf',
      sizeBytes: 64,
      checksumSha256: 'b'.repeat(64),
      status: 'AVAILABLE',
      uploadedByMemberId: gm.principal.memberId,
      uploadExpiresAt: inDays(1),
      completedAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

const generalIds = (): string[] =>
  [...vaultDocs]
    .filter(([, classification]) => classification === 'GENERAL')
    .map(([id]) => id)
    .sort();

/** Every page of the vault list for `q`, two rows per page. */
async function allPages(who: ActionContext, q: string): Promise<{ ids: string[]; pageSizes: number[] }> {
  const ids: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await s.as(who, () => vault.list(who, { q, limit: 2, ...(cursor === undefined ? {} : { cursor }) }));
    ids.push(...page.items.map((item) => item.id));
    pageSizes.push(page.items.length);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return { ids: ids.sort(), pageSizes };
}

const searchIds = async (who: ActionContext, q: string): Promise<string[]> =>
  (await s.as(who, () => search.search(who, { q, types: ['documents'], limit: 10 }))).groups
    .flatMap((group) => group.items.map((item) => item.id))
    .sort();

const dashboards = (cache = new DashboardCache(null)) =>
  new DashboardService(s.tenantDb, s.tenant, cache, () => new Date());

beforeAll(async () => {
  s = await startSeededDatabase();
  vault = new CorporateDocumentService(s.tenantDb, s.tenant);
  documents = new CommercialDocumentService(s.tenantDb, s.tenant);
  tenders = new TenderService(s.tenantDb, s.tenant);
  requirements = new TenderRequirementService(s.tenantDb, s.tenant);
  contracts = new ContractService(s.tenantDb, s.tenant);
  amendments = new AmendmentService(s.tenantDb, s.tenant);
  search = new SearchService(s.tenantDb, s.tenant);
  gm = await s.actionFor('EMP-00002');
  hr = await s.actionFor('EMP-00003');
  pm = await s.actionFor('EMP-00041');
  foreign = await s.actionFor('NW-001', s.northwindId);
  ihdProject = (
    await s.prisma.project.findFirstOrThrow({ where: { organizationId: s.demoId, code: 'IHD' }, select: { id: true } })
  ).id;

  // A. Visible GENERAL documents plus one document of each restricted classification, all expiring
  // within the dashboard's 30-day window.
  for (const classification of ['GENERAL', 'GENERAL', ...CLASSIFICATIONS] as const) {
    const created = await s.as(gm, () =>
      vault.create(gm, {
        documentType: classification === 'BANKING_RESTRICTED' ? 'BANK_LETTER' : 'LICENSE',
        title: `${MARK} ${classification} ${String(vaultDocs.size)}`,
        documentNumber: `${MARK}-${classification}-${String(vaultDocs.size)}`,
        classification,
      }),
    );
    vaultDocs.set(created.id, classification);
    const attachmentId = await attachment('CORPORATE_DOCUMENT', created.id);
    const versioned = await s.as(gm, () => vault.addVersion(gm, created.id, { attachmentId, expiryDate: isoDate(10) }));
    vaultVersions.set(classification, versioned.versions.find((version) => version.isCurrent)?.id ?? '');
  }
}, 300_000);

afterAll(async () => {
  await s.stop();
});

describe('corporate document vault', () => {
  it('B. a restricted caller gets only authorized rows, pages and counts', async () => {
    const { ids, pageSizes } = await allPages(hr, MARK);
    expect(ids).toEqual(generalIds());
    // Three visible rows at two per page: the pages hold 2 + 1, never a short page left by a hidden row.
    expect(pageSizes).toEqual([2, 1]);

    // The exact number of a restricted document finds nothing, in the list and in global search.
    for (const classification of CLASSIFICATIONS.slice(1)) {
      const number = `${MARK}-${classification}-`;
      expect((await s.as(hr, () => vault.list(hr, { q: number }))).items).toEqual([]);
      expect(await searchIds(hr, number)).toEqual([]);
    }
    expect(await searchIds(hr, MARK)).toEqual(generalIds());

    // Direct access and the attachment policy keep the inaccessible-record behaviour.
    for (const [id, classification] of vaultDocs) {
      if (classification === 'GENERAL') continue;
      await expect(s.as(hr, () => vault.get(hr, id))).rejects.toBeInstanceOf(NotFoundError);
      expect(await s.as(hr, () => vault.attachmentAccess(hr, id))).toEqual({
        canView: false,
        canUpload: false,
        canDelete: false,
      });
    }

    // Dashboard and Needs Attention count and list only what the list shows.
    const dashboard = await s.as(hr, () => dashboards().commercial(hr));
    expect(dashboard.commercial.documents?.expiring.value).toBe(generalIds().length);
    const attention = await s.as(hr, () =>
      new NeedsAttentionService(s.tenantDb, s.tenant, new DashboardCache(null)).list(hr),
    );
    const flagged = attention.items
      .filter((item) => item.type === 'CORPORATE_DOCUMENT_EXPIRING')
      .map((item) => item.entity.id)
      .sort();
    expect(flagged).toEqual(generalIds());
    const feed = JSON.stringify(attention);
    for (const id of [...vaultDocs.keys()].filter((key) => !generalIds().includes(key))) {
      expect(feed).not.toContain(id);
    }

    // The vault has no CSV export; a future one must extend this test.
    expect(commercialReportSchema.options.filter((report) => report.includes('document'))).toEqual([]);
  });

  it('C. a fully authorized caller sees the full count', async () => {
    const { ids, pageSizes } = await allPages(gm, MARK);
    expect(ids).toEqual([...vaultDocs.keys()].sort());
    expect(vaultDocs.size).toBe(6);
    expect(pageSizes).toEqual([2, 2, 2]);
    expect(await searchIds(gm, MARK)).toEqual([...vaultDocs.keys()].sort());
    const dashboard = await s.as(gm, () => dashboards().commercial(gm));
    expect(dashboard.commercial.documents?.expiring.value).toBe(vaultDocs.size);
  });

  it('D. a caller of another organization sees nothing', async () => {
    expect((await allPages(foreign, MARK)).ids).toEqual([]);
    expect(await searchIds(foreign, MARK)).toEqual([]);
    for (const id of vaultDocs.keys()) {
      await expect(s.as(foreign, () => vault.get(foreign, id))).rejects.toBeInstanceOf(NotFoundError);
    }
    const dashboard = await s.as(foreign, () => dashboards().commercial(foreign));
    expect(dashboard.commercial.documents?.expiring.value).toBe(0);
  });

  it('re-keys the cached dashboard when the restricted permission is granted and revoked', async () => {
    const cache = new DashboardCache(new InMemoryDashboardCacheStore());
    const expiring = async (): Promise<number | undefined> => {
      const fresh = await s.actionFor('EMP-00003');
      return (await s.as(fresh, () => dashboards(cache).commercial(fresh))).commercial.documents?.expiring.value;
    };
    expect(await expiring()).toBe(generalIds().length);
    const role = await s.prisma.role.findFirstOrThrow({
      where: { organizationId: s.demoId, key: 'TECHNICAL_MANAGER' },
      select: { id: true },
    });
    const grant = await s.prisma.memberRole.create({
      data: { organizationId: s.demoId, memberId: hr.principal.memberId, roleId: role.id },
      select: { id: true },
    });
    expect(await expiring()).toBe(vaultDocs.size);
    await s.prisma.memberRole.delete({ where: { id: grant.id } });
    expect(await expiring()).toBe(generalIds().length);

    // The same through an edit of the member's own role grants (custom-role administration).
    const own = await s.prisma.memberRole.findFirstOrThrow({
      where: { organizationId: s.demoId, memberId: hr.principal.memberId },
      select: { roleId: true },
    });
    const permission = await s.prisma.rolePermission.create({
      data: {
        organizationId: s.demoId,
        roleId: own.roleId,
        permissionKey: 'corporate_document.restricted.view',
        scope: 'ORG',
      },
      select: { id: true },
    });
    try {
      expect(await expiring()).toBe(vaultDocs.size);
    } finally {
      await s.prisma.rolePermission.delete({ where: { id: permission.id } });
    }
    expect(await expiring()).toBe(generalIds().length);
  });
});

describe('tender requirements and "used by"', () => {
  it('omits links to hidden documents (note and author included) and refuses to unlink them', async () => {
    const tender = await s.as(gm, () =>
      tenders.create(gm, {
        title: `${MARK} linked tender`,
        tenderType: 'RFQ',
        ownerMemberId: gm.principal.memberId,
        status: 'NEW',
        submissionDeadlineAt: inDays(20),
        submissionDeadlineTimeZone: 'Africa/Cairo',
        relatedProjectId: ihdProject,
      }),
    );
    const requirement = await s.as(gm, () =>
      requirements.create(gm, tender.id, {
        category: 'ADMINISTRATIVE',
        title: 'Licences on file',
        ownerMemberId: pm.principal.memberId,
        mandatory: true,
      }),
    );
    for (const classification of ['GENERAL', 'LEGAL_RESTRICTED'] as const) {
      await s.as(gm, () =>
        requirements.addLink(gm, tender.id, requirement.id, {
          corporateDocumentVersionId: vaultVersions.get(classification) ?? '',
          note: `${classification} note`,
        }),
      );
    }
    const full = await s.as(gm, () => requirements.get(gm, tender.id, requirement.id));
    expect(full.links).toHaveLength(2);
    const hiddenLink = full.links.find((link) => link.note === 'LEGAL_RESTRICTED note');

    // The project manager owns the requirement and reads the vault, but not restricted documents.
    const scoped = await s.as(pm, () => requirements.get(pm, tender.id, requirement.id));
    expect(scoped.links.map((link) => link.note)).toEqual(['GENERAL note']);
    expect(JSON.stringify(scoped)).not.toContain('LEGAL_RESTRICTED');
    await expect(
      s.as(pm, () => requirements.removeLink(pm, tender.id, requirement.id, hiddenLink?.id ?? '')),
    ).rejects.toBeInstanceOf(NotFoundError);

    // "Used by" of the restricted document is only reachable by those who may open it.
    const restrictedId = [...vaultDocs].find(([, c]) => c === 'LEGAL_RESTRICTED')?.[0] ?? '';
    expect((await s.as(gm, () => vault.get(gm, restrictedId))).linkedRequirements).toHaveLength(1);
    await expect(s.as(pm, () => vault.get(pm, restrictedId))).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('tender and contract documents', () => {
  /** One document of each classification on the parent, each with a version; returns version ids. */
  async function seedDocuments(
    create: (classification: Classification) => Promise<{ id: string }>,
  ): Promise<Map<Classification, { documentId: string; versionId: string }>> {
    const out = new Map<Classification, { documentId: string; versionId: string }>();
    for (const classification of CLASSIFICATIONS) {
      const document = await create(classification);
      const versioned = await s.as(gm, async () =>
        documents.addVersion(gm, document.id, { attachmentId: await attachment('COMMERCIAL_DOCUMENT', document.id) }),
      );
      out.set(classification, { documentId: document.id, versionId: versioned.versions[0]?.id ?? '' });
    }
    return out;
  }

  const category = (classification: Classification) =>
    classification === 'BANKING_RESTRICTED' ? 'BANKING' : 'ADMINISTRATIVE';

  it('lists, counts, times and references only the documents the caller may view', async () => {
    const tender = await s.as(gm, () =>
      tenders.create(gm, {
        title: `${MARK} documents tender`,
        tenderType: 'RFQ',
        ownerMemberId: gm.principal.memberId,
        status: 'NEW',
        submissionDeadlineAt: inDays(20),
        submissionDeadlineTimeZone: 'Africa/Cairo',
        relatedProjectId: ihdProject,
      }),
    );
    const tenderDocs = await seedDocuments((classification) =>
      s.as(gm, () =>
        documents.createForTender(gm, tender.id, {
          category: category(classification),
          classification,
          title: `${MARK} tender ${classification}`,
        }),
      ),
    );
    const generalTenderDoc = tenderDocs.get('GENERAL')?.documentId;

    const gmList = await s.as(gm, () => documents.listForTender(gm, tender.id));
    expect(gmList.items).toHaveLength(4);
    const pmList = await s.as(pm, () => documents.listForTender(pm, tender.id));
    expect(pmList).toEqual({ items: [expect.objectContaining({ id: generalTenderDoc })] });

    const documentEvents = async (who: ActionContext): Promise<unknown[]> =>
      (await s.as(who, () => tenders.timeline(who, tender.id, undefined, 100))).items
        .filter((event) => event.type === 'tender.document_added' || event.type === 'tender.document_version_added')
        .map((event) => event.params.documentId);
    expect(new Set(await documentEvents(gm))).toEqual(new Set([...tenderDocs.values()].map((d) => d.documentId)));
    expect(new Set(await documentEvents(pm))).toEqual(new Set([generalTenderDoc]));
    // Other events stay on the timeline (the NULL-safe filter drops only hidden document events).
    expect(
      (await s.as(pm, () => tenders.timeline(pm, tender.id, undefined, 100))).items.some(
        (event) => event.type === 'tender.created',
      ),
    ).toBe(true);

    // A restricted addendum document: its id reaches only callers who may open it.
    const current = await s.as(gm, () => tenders.get(gm, tender.id));
    const addendum = await s.as(gm, () =>
      tenders.createAddendum(gm, tender.id, {
        version: current.version,
        summary: 'Revised bill of quantities',
        receivedAt: inDays(0),
        documentVersionId: tenderDocs.get('LEGAL_RESTRICTED')?.versionId ?? null,
      }),
    );
    expect(addendum.documentVersionId).toBe(tenderDocs.get('LEGAL_RESTRICTED')?.versionId);
    const pmAddenda = await s.as(pm, () => tenders.listAddenda(pm, tender.id));
    expect(pmAddenda.find((row) => row.id === addendum.id)?.documentVersionId).toBeNull();

    const contract = await s.as(gm, () =>
      contracts.create(gm, {
        title: `${MARK} documents contract`,
        contractType: 'SUPPORT',
        currency: 'EGP',
        originalValue: '120000.00',
        startDate: isoDate(-30),
        expiryDate: isoDate(300),
        ownerMemberId: gm.principal.memberId,
        projectId: ihdProject,
      }),
    );
    const contractDocs = await seedDocuments((classification) =>
      s.as(gm, () =>
        documents.createForContract(gm, contract.id, {
          category: category(classification),
          classification,
          title: `${MARK} contract ${classification}`,
        }),
      ),
    );
    expect((await s.as(gm, () => documents.listForContract(gm, contract.id))).items).toHaveLength(4);
    expect(await s.as(pm, () => documents.listForContract(pm, contract.id))).toEqual({
      items: [expect.objectContaining({ id: contractDocs.get('GENERAL')?.documentId })],
    });

    let version = contract.version;
    for (const to of ['UNDER_REVIEW', 'AWAITING_SIGNATURE', 'ACTIVE'] as const) {
      version = (await s.as(gm, () => contracts.transition(gm, contract.id, { version, to }))).version;
    }
    const bankingVersion = contractDocs.get('BANKING_RESTRICTED')?.versionId ?? '';
    await s.as(gm, () =>
      contracts.recordRenewalAction(
        gm,
        contract.id,
        { version, action: 'REVIEW_STARTED', documentVersionId: bankingVersion },
        randomUUID(),
      ),
    );
    expect((await s.as(gm, () => contracts.listRenewalActions(gm, contract.id)))[0]?.documentVersionId).toBe(
      bankingVersion,
    );
    expect((await s.as(pm, () => contracts.listRenewalActions(pm, contract.id)))[0]?.documentVersionId).toBeNull();

    const legalVersion = contractDocs.get('LEGAL_RESTRICTED')?.versionId ?? '';
    const amendment = await s.as(gm, () =>
      amendments.create(gm, contract.id, {
        type: 'TIME_EXTENSION',
        title: 'Second term',
        effectiveDate: isoDate(0),
        newExpiryDate: isoDate(400),
        documentVersionId: legalVersion,
      }),
    );
    expect(amendment.documentVersionId).toBe(legalVersion);
    const pmAmendment = (await s.as(pm, () => amendments.list(pm, contract.id))).find((row) => row.id === amendment.id);
    expect(pmAmendment?.documentVersionId).toBeNull();
    expect(JSON.stringify(await s.as(pm, () => contracts.timeline(pm, contract.id, undefined, 100)))).not.toContain(
      contractDocs.get('LEGAL_RESTRICTED')?.documentId,
    );

    // Another organization reaches neither parent.
    await expect(s.as(foreign, () => documents.listForTender(foreign, tender.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.as(foreign, () => documents.listForContract(foreign, contract.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
