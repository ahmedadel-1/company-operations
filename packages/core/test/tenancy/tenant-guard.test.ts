import { describe, expect, it } from 'vitest';

import { TenantIsolationError } from '../../src/platform/errors.js';
import { assertTenantSafeOperation } from '../../src/platform/tenancy/tenant-guard.js';

const ORG_A = '0190f0a0-0000-7000-8000-00000000000a';
const ORG_B = '0190f0a0-0000-7000-8000-00000000000b';
const ID = '0190f0a0-0000-7000-8000-000000000001';

const check =
  (model: string, operation: string, args: unknown, org: string | null = ORG_A) =>
  (): void => {
    assertTenantSafeOperation(model, operation, args, org ?? undefined);
  };

describe('tenant guard: filters', () => {
  it.each(['findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy', 'deleteMany', 'delete'])(
    '%s requires a where clause bound to the active organization',
    (operation) => {
      expect(check('OrganizationMember', operation, {})).toThrow(TenantIsolationError);
      expect(check('OrganizationMember', operation, { where: { id: ID } })).toThrow(/not bound/);
      expect(check('OrganizationMember', operation, { where: { organizationId: ORG_B } })).toThrow(
        /different organization/,
      );
      expect(check('OrganizationMember', operation, { where: { organizationId: ORG_A } })).not.toThrow();
    },
  );

  it('accepts equality forms and compound unique keys', () => {
    expect(check('Role', 'findFirst', { where: { organizationId: { equals: ORG_A } } })).not.toThrow();
    expect(
      check('Role', 'findUnique', { where: { organizationId_id: { organizationId: ORG_A, id: ID } } }),
    ).not.toThrow();
    expect(
      check('Role', 'findUniqueOrThrow', { where: { organizationId_key: { organizationId: ORG_A, key: 'X' } } }),
    ).not.toThrow();
  });

  it('rejects findUnique by id alone and compound keys for another organization', () => {
    expect(check('Role', 'findUnique', { where: { id: ID } })).toThrow(/not bound/);
    expect(check('Role', 'findUnique', { where: { organizationId_id: { organizationId: ORG_B, id: ID } } })).toThrow(
      /different organization/,
    );
  });

  it('rejects non-equality operators on organizationId', () => {
    for (const filter of [{ in: [ORG_A, ORG_B] }, { not: ORG_B }, { equals: ORG_A, not: ORG_B }, { gt: ORG_A }, null]) {
      expect(check('Role', 'findMany', { where: { organizationId: filter } })).toThrow(/equality/);
    }
  });

  it('rejects a forged second binding even when one binding is correct', () => {
    expect(
      check('Role', 'findFirst', {
        where: { organizationId: ORG_A, organizationId_id: { organizationId: ORG_B, id: ID } },
      }),
    ).toThrow(/different organization/);
  });

  it('OR/NOT clauses cannot widen a bound filter (top-level keys are AND-ed)', () => {
    expect(
      check('OrganizationMember', 'findMany', { where: { organizationId: ORG_A, OR: [{ organizationId: ORG_B }] } }),
    ).not.toThrow();
    expect(check('OrganizationMember', 'findMany', { where: { OR: [{ organizationId: ORG_A }] } })).toThrow(
      /not bound/,
    );
  });

  it('fails closed without an active tenant context', () => {
    expect(check('Role', 'findMany', { where: { organizationId: ORG_A } }, null)).toThrow(/no active tenant context/);
  });
});

describe('tenant guard: writes', () => {
  it('create must set organizationId to the active organization', () => {
    expect(check('Role', 'create', { data: { key: 'X', name: 'X' } })).toThrow(/organizationId/);
    expect(check('Role', 'create', { data: { organizationId: ORG_B, key: 'X', name: 'X' } })).toThrow(/organizationId/);
    expect(check('Role', 'create', { data: { organizationId: ORG_A, key: 'X', name: 'X' } })).not.toThrow();
  });

  it('createMany / createManyAndReturn check every row', () => {
    for (const operation of ['createMany', 'createManyAndReturn']) {
      expect(
        check('RolePermission', operation, {
          data: [
            { organizationId: ORG_A, roleId: ID, permissionKey: 'employee.view', scope: 'ORG' },
            { organizationId: ORG_B, roleId: ID, permissionKey: 'employee.view', scope: 'ORG' },
          ],
        }),
      ).toThrow(/organizationId/);
      expect(check('RolePermission', operation, { data: [] })).toThrow(/no rows/);
    }
  });

  it('rejects nested relation writes on create and update', () => {
    expect(
      check('OrganizationMember', 'create', {
        data: { organizationId: ORG_A, userId: ID, roles: { create: { organizationId: ORG_B, roleId: ID } } },
      }),
    ).toThrow(/nested relation writes/);
    expect(
      check('OrganizationMember', 'update', {
        where: { organizationId_id: { organizationId: ORG_A, id: ID } },
        data: { organization: { connect: { id: ORG_B } } },
      }),
    ).toThrow(/nested relation writes/);
  });

  it.each(['update', 'updateMany', 'updateManyAndReturn'])(
    '%s needs a bound filter and cannot move rows',
    (operation) => {
      expect(check('Role', operation, { where: { id: ID }, data: { name: 'Y' } })).toThrow(/not bound/);
      expect(check('Role', operation, { where: { organizationId: ORG_A }, data: { organizationId: ORG_B } })).toThrow(
        /cannot be changed/,
      );
      expect(check('Role', operation, { where: { organizationId: ORG_A }, data: { name: 'Y' } })).not.toThrow();
    },
  );

  it('upsert checks the filter, the create branch and the update branch', () => {
    const where = { organizationId_key: { organizationId: ORG_A, key: 'X' } };
    expect(
      check('Role', 'upsert', { where, create: { organizationId: ORG_A, key: 'X', name: 'X' }, update: {} }),
    ).not.toThrow();
    expect(
      check('Role', 'upsert', { where, create: { organizationId: ORG_B, key: 'X', name: 'X' }, update: {} }),
    ).toThrow();
    expect(
      check('Role', 'upsert', {
        where,
        create: { organizationId: ORG_A, key: 'X', name: 'X' },
        update: { organizationId: ORG_B },
      }),
    ).toThrow();
    expect(
      check('Role', 'upsert', {
        where: { organizationId_key: { organizationId: ORG_B, key: 'X' } },
        create: { organizationId: ORG_A, key: 'X', name: 'X' },
        update: {},
      }),
    ).toThrow();
  });

  it('rejects operations it does not know', () => {
    expect(check('Role', 'somethingNew', { where: { organizationId: ORG_A } })).toThrow(/not supported/);
  });
});

describe('tenant guard: model classes', () => {
  it('limits the tenant root to the active organization and safe operations', () => {
    expect(check('Organization', 'findUnique', { where: { id: ORG_A } })).not.toThrow();
    expect(check('Organization', 'findUnique', { where: { id: ORG_B } })).toThrow(/only the active organization/);
    expect(check('Organization', 'findMany', {})).toThrow(/not allowed on the tenant root/);
    expect(check('Organization', 'create', { data: {} })).toThrow(/not allowed/);
    expect(check('Organization', 'delete', { where: { id: ORG_A } })).toThrow(/not allowed/);
    expect(check('Organization', 'update', { where: { id: ORG_A }, data: { name: 'n' } })).not.toThrow();
    expect(check('Organization', 'update', { where: { id: ORG_A }, data: { id: ORG_B } })).toThrow(
      /id cannot be changed/,
    );
    expect(check('Organization', 'update', { where: { id: ORG_A }, data: { members: { create: {} } } })).toThrow(
      /nested/,
    );
  });

  it('never exposes global identity or platform data directly', () => {
    expect(check('User', 'findMany', {})).toThrow(/global identity/);
    expect(check('User', 'findUnique', { where: { id: ID } })).toThrow(/global identity/);
    expect(check('PlatformAuditLog', 'findMany', {})).toThrow(/platform data/);
  });

  it('rejects unknown models', () => {
    expect(check('Nope', 'findMany', {})).toThrow(/unknown model/);
  });
});
