import { describe, expect, it } from 'vitest';

import { SYSTEM_ROLE_KEYS } from '@company-ops/shared';

import { assertProductionConfirmed, ProductionConfirmationError } from '../../src/bootstrap/production-confirmation.js';
import { DEMO_ORGANIZATION, DEMO_USERS } from '../../src/dev-seed/demo-data.js';
import { assertSeedAllowed, SeedRefusedError } from '../../src/dev-seed/seed.js';
import { isValidTimeZone } from '../../src/modules/organizations/provision-organization.js';

describe('dev seed guard', () => {
  it('refuses production and requires the explicit opt-in', () => {
    const run = (nodeEnv: string, allow: boolean) => (): void => {
      assertSeedAllowed(nodeEnv, allow);
    };
    expect(run('production', true)).toThrow(SeedRefusedError);
    expect(run('development', false)).toThrow(/ALLOW_DEMO_SEED/);
    expect(run('development', true)).not.toThrow();
    expect(run('test', true)).not.toThrow();
  });
});

describe('bootstrap production confirmation', () => {
  it('requires repeating the slug in production only', () => {
    const run = (nodeEnv: string, confirmation: string | undefined) => (): void => {
      assertProductionConfirmed(nodeEnv, 'acme', confirmation);
    };
    expect(run('production', undefined)).toThrow(ProductionConfirmationError);
    expect(run('production', 'other')).toThrow(ProductionConfirmationError);
    expect(run('production', 'acme')).not.toThrow();
    expect(run('development', undefined)).not.toThrow();
  });
});

describe('demo data', () => {
  it('uses Africa/Cairo and a Sunday-Thursday work week as seed values', () => {
    expect(DEMO_ORGANIZATION.timeZone).toBe('Africa/Cairo');
    expect(DEMO_ORGANIZATION.workWeek).toEqual([7, 1, 2, 3, 4]);
    expect(isValidTimeZone(DEMO_ORGANIZATION.timeZone)).toBe(true);
  });

  it('has unique subjects/usernames and only known role keys', () => {
    expect(new Set(DEMO_USERS.map((u) => u.subject)).size).toBe(DEMO_USERS.length);
    expect(new Set(DEMO_USERS.map((u) => u.username)).size).toBe(DEMO_USERS.length);
    const known: ReadonlySet<string> = new Set(SYSTEM_ROLE_KEYS);
    for (const user of DEMO_USERS) {
      for (const role of user.membership?.roles ?? []) {
        expect(known.has(role)).toBe(true);
      }
    }
  });

  it('covers the identities the security tests rely on', () => {
    expect(DEMO_USERS.some((u) => u.membership?.status === 'DISABLED')).toBe(true);
    expect(DEMO_USERS.some((u) => u.membership === null)).toBe(true);
    expect(DEMO_USERS.some((u) => u.membership?.roles.includes('ORG_ADMIN'))).toBe(true);
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects anything else', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('+02:00')).toBe(false);
  });
});
