import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActionContext } from '../../src/modules/action-context.js';
import { ContractService } from '../../src/modules/commercial/contract.service.js';
import { GuaranteeService } from '../../src/modules/commercial/guarantee.service.js';
import { TenderService } from '../../src/modules/commercial/tender.service.js';
import { SearchService } from '../../src/modules/dashboard/search.service.js';
import type { SearchType } from '../../src/modules/dashboard/search.service.js';
import { startSeededDatabase } from '../support/seeded-database.js';
import type { SeededDatabase } from '../support/seeded-database.js';

/**
 * Global search over the commercial domain (spec §52): guarantee references and issuers, tender and
 * contract numbers and titles, and the customer name. Every group uses the visibility of the record
 * it opens; nothing tells an unauthorized caller that a reference exists, and snippets never carry
 * money.
 *
 * Actors: EMP-00002 general manager (ORG scope, financial permissions); EMP-00041 project manager of
 * IHD (IHD tenders and contracts, no financial permission); EMP-00004 employee who owns one guarantee
 * and nothing else commercial; EMP-00031 field employee without commercial permissions; NW-001 general
 * manager of the second organization.
 */
const RUN = randomUUID().slice(0, 6).toUpperCase();
const REF = `LG${RUN}`;

let s: SeededDatabase;
let search: SearchService;
let gm: ActionContext;
let pm: ActionContext;
let owner: ActionContext;
let field: ActionContext;
let foreign: ActionContext;
let projectGuarantee: string;
let otherGuarantee: string;
let ownedGuarantee: string;
let customerName: string;
let customerTender: { id: string; key: string };
let customerContract: { id: string; key: string };

const isoDate = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function found(who: ActionContext, q: string, type: SearchType): Promise<{ ids: string[]; json: string }> {
  const response = await s.as(who, () => search.search(who, { q, types: [type], limit: 10 }));
  return {
    ids: response.groups.flatMap((group) => group.items.map((item) => item.id)).sort(),
    json: JSON.stringify(response),
  };
}

beforeAll(async () => {
  s = await startSeededDatabase();
  search = new SearchService(s.tenantDb, s.tenant);
  const contracts = new ContractService(s.tenantDb, s.tenant);
  const guarantees = new GuaranteeService(s.tenantDb, s.tenant);
  const tenders = new TenderService(s.tenantDb, s.tenant);
  gm = await s.actionFor('EMP-00002');
  pm = await s.actionFor('EMP-00041');
  owner = await s.actionFor('EMP-00004');
  field = await s.actionFor('EMP-00031');
  foreign = await s.actionFor('NW-001', s.northwindId);
  const ihd = await s.prisma.project.findFirstOrThrow({
    where: { organizationId: s.demoId, code: 'IHD' },
    select: { id: true },
  });
  const customer = await s.prisma.customer.findFirstOrThrow({
    where: { organizationId: s.demoId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  customerName = customer.name;

  const contract = (title: string, projectId: string | null, customerId: string | null = null) =>
    s.as(gm, () =>
      contracts.create(gm, {
        title,
        contractType: 'SUPPORT',
        currency: 'EGP',
        originalValue: '640000.00',
        startDate: isoDate(-10),
        expiryDate: isoDate(200),
        ownerMemberId: gm.principal.memberId,
        projectId,
        customerId,
      }),
    );
  const guarantee = (contractId: string, suffix: string, ownerMemberId: string | null = null) =>
    s.as(gm, () =>
      guarantees.createForContract(gm, contractId, {
        type: 'PERFORMANCE_GUARANTEE',
        referenceNumber: `${REF}-${suffix}`,
        issuer: `Delta Bank ${RUN}`,
        amount: '73519.00',
        currency: 'EGP',
        issueDate: isoDate(-5),
        expiryDate: isoDate(120),
        ownerMemberId,
      }),
    );
  const ihdContract = await contract(`Search IHD ${RUN}`, ihd.id);
  const otherContract = await contract(`Search other ${RUN}`, null);
  projectGuarantee = (await guarantee(ihdContract.id, '001')).id;
  otherGuarantee = (await guarantee(otherContract.id, '002')).id;
  ownedGuarantee = (await guarantee(otherContract.id, '003', owner.principal.memberId)).id;

  const tender = await s.as(gm, () =>
    tenders.create(gm, {
      title: `Customer search tender ${RUN}`,
      tenderType: 'RFQ',
      ownerMemberId: gm.principal.memberId,
      status: 'NEW',
      submissionDeadlineAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      submissionDeadlineTimeZone: 'Africa/Cairo',
      customerId: customer.id,
      relatedProjectId: ihd.id,
    }),
  );
  customerTender = { id: tender.id, key: tender.key };
  const customerContractRow = await contract(`Customer search contract ${RUN}`, null, customer.id);
  customerContract = { id: customerContractRow.id, key: customerContractRow.key };
}, 300_000);

afterAll(async () => {
  await s.stop();
});

describe('guarantee reference search', () => {
  it('finds a reference for callers who see the guarantee, by full or partial reference and by issuer', async () => {
    expect((await found(gm, `${REF}-001`, 'guarantees')).ids).toEqual([projectGuarantee]);
    expect((await found(gm, REF, 'guarantees')).ids).toEqual([projectGuarantee, otherGuarantee, ownedGuarantee].sort());
    expect((await found(gm, `delta bank ${RUN}`, 'guarantees')).ids).toEqual(
      [projectGuarantee, otherGuarantee, ownedGuarantee].sort(),
    );
    // Project scope: the IHD contract's guarantee only.
    expect((await found(pm, `${REF}-001`, 'guarantees')).ids).toEqual([projectGuarantee]);
    // The owner of a guarantee finds it, and only it.
    expect((await found(owner, REF, 'guarantees')).ids).toEqual([ownedGuarantee]);
  });

  it('gives an unauthorized caller no evidence of a reference, partial or exact', async () => {
    // Out of scope: the exact reference and every prefix of it find nothing.
    for (const q of [`${REF}-002`, `${REF}-00`, REF, REF.slice(0, 4)]) {
      expect((await found(pm, q, 'guarantees')).ids).not.toContain(otherGuarantee);
    }
    expect((await found(pm, REF, 'guarantees')).ids).toEqual([projectGuarantee]);
    // No commercial permission at all.
    expect((await found(field, REF, 'guarantees')).ids).toEqual([]);
    expect((await found(field, `delta bank ${RUN}`, 'guarantees')).ids).toEqual([]);
    // Another organization: the same exact reference and issuer find nothing.
    for (const q of [`${REF}-001`, REF, `delta bank ${RUN}`]) {
      expect((await found(foreign, q, 'guarantees')).ids).toEqual([]);
    }
  });

  it('keeps the guarantee amount out of every snippet, for every caller', async () => {
    for (const who of [gm, pm, owner]) {
      const { ids, json } = await found(who, REF, 'guarantees');
      expect(ids.length).toBeGreaterThan(0);
      expect(json).not.toContain('73519');
      expect(json).not.toContain('73,519');
    }
  });
});

describe('tender and contract search', () => {
  it('matches numbers, titles and the customer name within the caller visibility only', async () => {
    expect((await found(gm, customerTender.key, 'tenders')).ids).toEqual([customerTender.id]);
    expect((await found(gm, customerContract.key, 'contracts')).ids).toEqual([customerContract.id]);
    expect((await found(gm, `Customer search tender ${RUN}`, 'tenders')).ids).toEqual([customerTender.id]);

    // The customer name finds the tender and the contract of that customer for the general manager.
    expect((await found(gm, customerName, 'tenders')).ids).toContain(customerTender.id);
    expect((await found(gm, customerName, 'contracts')).ids).toContain(customerContract.id);
    // The project manager sees the IHD tender of that customer, not the unrelated contract.
    expect((await found(pm, customerName, 'tenders')).ids).toContain(customerTender.id);
    expect((await found(pm, customerName, 'contracts')).ids).not.toContain(customerContract.id);
    expect((await found(pm, customerContract.key, 'contracts')).ids).toEqual([]);
    // No commercial permission and other organizations: nothing, by key, title or customer.
    for (const who of [field, foreign]) {
      for (const q of [customerTender.key, customerContract.key, customerName, RUN]) {
        expect((await found(who, q, 'tenders')).ids).toEqual([]);
        expect((await found(who, q, 'contracts')).ids).toEqual([]);
      }
    }
    // Snippets carry the key, title and status, never the contract value.
    expect((await found(gm, customerContract.key, 'contracts')).json).not.toContain('640000');
  });
});
