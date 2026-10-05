import type { SystemRoleKey } from '@company-ops/shared';

/**
 * Development demo data (ROADMAP P1-4, Phase 1B subset). Time zone and work week are seed values
 * for the demo organization only; the application has no defaults for them (DATA_MODEL §3).
 */
export const DEMO_ORGANIZATION = {
  slug: 'demo',
  name: 'Demo Company',
  timeZone: 'Africa/Cairo',
  // ISO weekdays: Sunday (7) to Thursday (4).
  workWeek: [7, 1, 2, 3, 4],
  defaultLocale: 'en',
} as const;

export interface DemoUser {
  /** Keycloak user id in infra/docker/keycloak/realms/company-ops-realm.json = OIDC `sub`. */
  readonly subject: string;
  readonly username: string;
  readonly email: string;
  readonly displayName: string;
  /** null = no membership in the demo organization (used to demonstrate rejection). */
  readonly membership: { readonly status: 'ACTIVE' | 'DISABLED'; readonly roles: readonly SystemRoleKey[] } | null;
}

export const DEMO_USERS: readonly DemoUser[] = [
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
    username: 'org.admin',
    email: 'org.admin@demo.company-ops.test',
    displayName: 'Olivia Admin',
    membership: { status: 'ACTIVE', roles: ['ORG_ADMIN'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
    username: 'gm',
    email: 'gm@demo.company-ops.test',
    displayName: 'George Manager',
    membership: { status: 'ACTIVE', roles: ['GENERAL_MANAGER'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f03',
    username: 'hr',
    email: 'hr@demo.company-ops.test',
    displayName: 'Hana Resources',
    membership: { status: 'ACTIVE', roles: ['HR_ADMIN'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
    username: 'employee',
    email: 'employee@demo.company-ops.test',
    displayName: 'Emad Employee',
    membership: { status: 'ACTIVE', roles: ['EMPLOYEE'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f05',
    username: 'disabled',
    email: 'disabled@demo.company-ops.test',
    displayName: 'Dina Disabled',
    membership: { status: 'DISABLED', roles: ['EMPLOYEE'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f06',
    username: 'outsider',
    email: 'outsider@demo.company-ops.test',
    displayName: 'Omar Outsider',
    membership: null,
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f07',
    username: 'field',
    email: 'field@demo.company-ops.test',
    displayName: 'Fatma Field',
    membership: { status: 'ACTIVE', roles: ['FIELD_EMPLOYEE'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f08',
    username: 'manager',
    email: 'manager@demo.company-ops.test',
    displayName: 'Mina Manager',
    membership: { status: 'ACTIVE', roles: ['TECHNICAL_MANAGER'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f09',
    username: 'support',
    email: 'support@demo.company-ops.test',
    displayName: 'Sara Support',
    membership: { status: 'ACTIVE', roles: ['SUPPORT_AGENT'] },
  },
  {
    subject: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f0a',
    username: 'pm',
    email: 'pm@demo.company-ops.test',
    displayName: 'Paul Planner',
    membership: { status: 'ACTIVE', roles: ['PROJECT_MANAGER'] },
  },
];
