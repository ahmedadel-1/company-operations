import type { SystemRoleKey } from '@company-ops/shared';

/**
 * Development people data (ROADMAP P1-4): departments, job titles, teams and ~30 employees for the
 * demo organization, and a small second organization so a multi-organization account (`gm`) can
 * switch organizations. Synthetic employees get global users with seed-only subjects that no
 * identity-provider account matches, so they can never sign in.
 */
export interface DemoDepartment {
  readonly code: string;
  readonly name: string;
  readonly parentCode: string | null;
  /** Employee number of the department manager. */
  readonly managerNumber: string | null;
}

export interface DemoEmployee {
  readonly employeeNumber: string;
  readonly fullName: string;
  readonly workEmail: string;
  readonly phone: string;
  readonly departmentCode: string;
  readonly jobTitle: string;
  readonly managerNumber: string | null;
  /** Keycloak demo user subject (see demo-data.ts), or null for a synthetic employee. */
  readonly demoSubject: string | null;
  readonly roles: readonly SystemRoleKey[];
}

export interface DemoTeam {
  readonly name: string;
  readonly departmentCode: string;
  readonly leadNumber: string;
  readonly memberNumbers: readonly string[];
}

export const DEMO_JOB_TITLES = [
  'General Manager',
  'Engineering Manager',
  'Senior Software Engineer',
  'Software Engineer',
  'HR Specialist',
  'Support Specialist',
  'Field Technician',
  'Operations Manager',
  'Administrator',
] as const;

export const DEMO_DEPARTMENTS: readonly DemoDepartment[] = [
  { code: 'MGMT', name: 'Management', parentCode: null, managerNumber: 'EMP-00002' },
  { code: 'ENG', name: 'Engineering', parentCode: null, managerNumber: 'EMP-00006' },
  { code: 'ENG-PLT', name: 'Platform', parentCode: 'ENG', managerNumber: 'EMP-00007' },
  { code: 'ENG-APP', name: 'Applications', parentCode: 'ENG', managerNumber: 'EMP-00012' },
  { code: 'HR', name: 'Human Resources', parentCode: null, managerNumber: 'EMP-00003' },
  { code: 'SUP', name: 'Support', parentCode: null, managerNumber: 'EMP-00017' },
  { code: 'FIELD', name: 'Field Operations', parentCode: null, managerNumber: 'EMP-00023' },
];

const S = {
  admin: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f01',
  gm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f02',
  hr: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f03',
  employee: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f04',
  disabled: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f05',
  field: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f07',
  manager: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f08',
  support: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f09',
  pm: '6f1c3a52-5d0e-4c43-9a8e-0b1d2c3e4f0a',
} as const;

const e = (
  n: number,
  fullName: string,
  departmentCode: string,
  jobTitle: string,
  managerNumber: number | null,
  roles: readonly SystemRoleKey[] = ['EMPLOYEE'],
  demoSubject: string | null = null,
): DemoEmployee => {
  const employeeNumber = `EMP-${String(n).padStart(5, '0')}`;
  const local = fullName.toLowerCase().replace(/[^a-z]+/g, '.');
  return {
    employeeNumber,
    fullName,
    workEmail: `${local}@demo.company-ops.test`,
    phone: `+20 100 000 ${String(1000 + n)}`,
    departmentCode,
    jobTitle,
    managerNumber: managerNumber === null ? null : `EMP-${String(managerNumber).padStart(5, '0')}`,
    demoSubject,
    roles,
  };
};

/** Demo users keep the roles from demo-data.ts; the people seed only adds their profiles. */
export const DEMO_EMPLOYEES: readonly DemoEmployee[] = [
  e(1, 'Olivia Admin', 'MGMT', 'Administrator', 2, [], S.admin),
  e(2, 'George Manager', 'MGMT', 'General Manager', null, [], S.gm),
  e(3, 'Hana Resources', 'HR', 'HR Specialist', 2, [], S.hr),
  e(4, 'Emad Employee', 'ENG-APP', 'Software Engineer', 12, [], S.employee),
  e(5, 'Dina Disabled', 'SUP', 'Support Specialist', 17, [], S.disabled),
  e(6, 'Tarek Hassan', 'ENG', 'Engineering Manager', 2, ['TECHNICAL_MANAGER']),
  e(7, 'Mona Farouk', 'ENG-PLT', 'Engineering Manager', 6, ['DEPARTMENT_MANAGER']),
  e(8, 'Youssef Nabil', 'ENG-PLT', 'Senior Software Engineer', 7, ['TEAM_LEAD']),
  e(9, 'Salma Adel', 'ENG-PLT', 'Software Engineer', 8),
  e(10, 'Karim Mostafa', 'ENG-PLT', 'Software Engineer', 8),
  e(11, 'Nour Ibrahim', 'ENG-PLT', 'Software Engineer', 8),
  e(12, 'Ahmed Samir', 'ENG-APP', 'Engineering Manager', 6, ['DEPARTMENT_MANAGER']),
  e(13, 'Laila Fathy', 'ENG-APP', 'Senior Software Engineer', 12, ['TEAM_LEAD']),
  e(14, 'Omar Khaled', 'ENG-APP', 'Software Engineer', 13),
  e(15, 'Rana Magdy', 'ENG-APP', 'Software Engineer', 13),
  e(16, 'Hassan Ali', 'ENG-APP', 'Software Engineer', 13),
  e(17, 'Yasmin Tamer', 'SUP', 'Operations Manager', 2, ['DEPARTMENT_MANAGER']),
  e(18, 'Mahmoud Reda', 'SUP', 'Support Specialist', 17, ['SUPPORT_AGENT']),
  e(19, 'Farida Sherif', 'SUP', 'Support Specialist', 17, ['SUPPORT_AGENT']),
  e(20, 'Ziad Hamdy', 'SUP', 'Support Specialist', 17, ['SUPPORT_AGENT']),
  e(21, 'Aya Mansour', 'HR', 'HR Specialist', 3),
  e(22, 'Sherif Wael', 'HR', 'HR Specialist', 3),
  e(23, 'Khaled Ezzat', 'FIELD', 'Operations Manager', 2, ['DEPARTMENT_MANAGER']),
  e(24, 'Mariam Gamal', 'FIELD', 'Field Technician', 23, ['FIELD_EMPLOYEE']),
  e(25, 'Mostafa Saad', 'FIELD', 'Field Technician', 23, ['FIELD_EMPLOYEE']),
  e(26, 'Heba Lotfy', 'FIELD', 'Field Technician', 23, ['FIELD_EMPLOYEE']),
  e(27, 'Amr Zaki', 'FIELD', 'Field Technician', 23, ['FIELD_EMPLOYEE']),
  e(28, 'Dalia Fouad', 'ENG-PLT', 'Software Engineer', 8),
  e(29, 'Walid Naguib', 'ENG-APP', 'Software Engineer', 13),
  e(30, 'Reem Hosny', 'SUP', 'Support Specialist', 17, ['SUPPORT_AGENT']),
  e(31, 'Fatma Field', 'FIELD', 'Field Technician', 23, [], S.field),
  e(32, 'Mina Manager', 'ENG', 'Engineering Manager', 6, [], S.manager),
  e(40, 'Sara Support', 'SUP', 'Support Specialist', 17, [], S.support),
  e(41, 'Paul Planner', 'ENG-APP', 'Senior Software Engineer', 12, [], S.pm),
];

export const DEMO_TEAMS: readonly DemoTeam[] = [
  {
    name: 'Platform Core',
    departmentCode: 'ENG-PLT',
    leadNumber: 'EMP-00008',
    memberNumbers: ['EMP-00009', 'EMP-00010', 'EMP-00011', 'EMP-00028'],
  },
  {
    name: 'Customer Apps',
    departmentCode: 'ENG-APP',
    leadNumber: 'EMP-00013',
    memberNumbers: ['EMP-00004', 'EMP-00014', 'EMP-00015', 'EMP-00016', 'EMP-00029'],
  },
  {
    name: 'Support Tier 1',
    departmentCode: 'SUP',
    leadNumber: 'EMP-00018',
    memberNumbers: ['EMP-00019', 'EMP-00020', 'EMP-00030', 'EMP-00040'],
  },
];

/** Second organization: `gm` is a member of both, so organization switching can be exercised. */
export const SECOND_ORGANIZATION = {
  slug: 'northwind',
  name: 'Northwind Trading',
  timeZone: 'Europe/London',
  workWeek: [1, 2, 3, 4, 5],
  defaultLocale: 'en',
} as const;

export const SECOND_ORG_EMPLOYEES: readonly DemoEmployee[] = [
  {
    employeeNumber: 'NW-001',
    fullName: 'George Manager',
    workEmail: 'gm@northwind.company-ops.test',
    phone: '+44 20 0000 0001',
    departmentCode: 'OPS',
    jobTitle: 'General Manager',
    managerNumber: null,
    demoSubject: S.gm,
    roles: ['GENERAL_MANAGER'],
  },
  {
    employeeNumber: 'NW-002',
    fullName: 'Paula Jensen',
    workEmail: 'paula.jensen@northwind.company-ops.test',
    phone: '+44 20 0000 0002',
    departmentCode: 'OPS',
    jobTitle: 'Operations Manager',
    managerNumber: 'NW-001',
    demoSubject: null,
    roles: ['EMPLOYEE'],
  },
  {
    employeeNumber: 'NW-003',
    fullName: 'Liam Carter',
    workEmail: 'liam.carter@northwind.company-ops.test',
    phone: '+44 20 0000 0003',
    departmentCode: 'OPS',
    jobTitle: 'Field Technician',
    managerNumber: 'NW-002',
    demoSubject: null,
    roles: ['EMPLOYEE'],
  },
];

export const SECOND_ORG_DEPARTMENTS: readonly DemoDepartment[] = [
  { code: 'OPS', name: 'Operations', parentCode: null, managerNumber: 'NW-001' },
];

export const SECOND_ORG_JOB_TITLES = ['General Manager', 'Operations Manager', 'Field Technician'] as const;
