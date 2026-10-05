import type { Prisma, RequestCategory } from '@company-ops/db';
import type { SystemRoleKey } from '@company-ops/shared';
import {
  ATTENDANCE_CORRECTION_TYPE_KEY,
  createRequestTypeSchema,
  workflowContentSchema,
} from '@company-ops/validation';
import type { LocalizedText, RequestTypeIcon, WorkflowContent } from '@company-ops/validation';

import { correctionTypeContent } from '../modules/attendance/correction-type.js';
import { recordAudit } from '../platform/audit/audit-writer.js';
import { workflowPublishIssues } from '../modules/requests/engine/workflow.js';
import { stepRows, versionColumns } from '../modules/requests/request-type-admin.service.js';

/**
 * Development request types (ROADMAP P6-7, P7-5): Leave, Work from home, Laptop, Software access,
 * Purchase, Business mission and Short permission, each active with one published workflow version
 * (the reserved Attendance correction type is provisioned on first use). Idempotent by type key;
 * existing types (and any versions an administrator published since) are never changed.
 */
interface SeedType {
  readonly key: string;
  readonly name: LocalizedText;
  readonly description: LocalizedText;
  readonly category: RequestCategory;
  readonly icon: RequestTypeIcon;
  /** Role-based approvers by system role key, resolved to this organization's role ids. */
  readonly content: (role: (key: SystemRoleKey) => string) => unknown;
}

const NOTIFY = { emailApprovers: true, emailRequester: true } as const;
const MANAGER_STEP = {
  kind: 'APPROVAL',
  name: { en: 'Manager approval', ar: 'موافقة المدير' },
  mode: 'ANY_ONE',
  approver: { type: 'DIRECT_MANAGER' },
  slaHours: 24,
} as const;
const REASON = {
  key: 'reason',
  type: 'textarea',
  label: { en: 'Reason', ar: 'السبب' },
  required: true,
  maxLength: 1000,
} as const;

const SEED_TYPES: readonly SeedType[] = [
  {
    key: 'leave',
    name: { en: 'Leave', ar: 'إجازة' },
    description: { en: 'Annual, sick or unpaid leave.', ar: 'إجازة سنوية أو مرضية أو بدون أجر.' },
    category: 'HR',
    icon: 'calendar',
    content: (role) => ({
      form: {
        fields: [
          {
            key: 'leaveType',
            type: 'select',
            label: { en: 'Leave type', ar: 'نوع الإجازة' },
            required: true,
            options: [
              { value: 'annual', label: { en: 'Annual', ar: 'سنوية' } },
              { value: 'sick', label: { en: 'Sick', ar: 'مرضية' } },
              { value: 'unpaid', label: { en: 'Unpaid', ar: 'بدون أجر' } },
            ],
          },
          {
            key: 'dates',
            type: 'date_range',
            label: { en: 'Dates', ar: 'التواريخ' },
            required: true,
            maxDays: 30,
          },
          {
            key: 'sickNote',
            type: 'info',
            label: { en: 'Attach a medical certificate', ar: 'أرفق شهادة طبية' },
            visibleWhen: { match: 'all', rules: [{ field: 'leaveType', op: 'eq', value: 'sick' }] },
          },
          { ...REASON, required: false },
        ],
      },
      steps: [
        MANAGER_STEP,
        {
          kind: 'APPROVAL',
          name: { en: 'HR approval', ar: 'موافقة الموارد البشرية' },
          mode: 'ANY_ONE',
          approver: { type: 'ROLE', roleId: role('HR_ADMIN') },
          condition: { match: 'all', rules: [{ field: 'leaveType', op: 'eq', value: 'unpaid' }] },
          slaHours: 48,
        },
      ],
      attachments: { requirement: 'OPTIONAL', maxFiles: 3 },
      effects: { attendance: { mode: 'LEAVE', dateField: 'dates' } },
      notifications: NOTIFY,
    }),
  },
  {
    key: 'work_from_home',
    name: { en: 'Work from home', ar: 'العمل من المنزل' },
    description: { en: 'Work remotely for up to five days.', ar: 'العمل عن بعد لمدة تصل إلى خمسة أيام.' },
    category: 'HR',
    icon: 'home',
    content: () => ({
      form: {
        fields: [
          {
            key: 'dates',
            type: 'date_range',
            label: { en: 'Dates', ar: 'التواريخ' },
            required: true,
            notInPast: true,
            maxDays: 5,
          },
          REASON,
        ],
      },
      steps: [MANAGER_STEP],
      attachments: { requirement: 'NONE', maxFiles: 0 },
      effects: { attendance: { mode: 'REMOTE', dateField: 'dates' } },
      notifications: NOTIFY,
    }),
  },
  {
    key: 'laptop',
    name: { en: 'Laptop', ar: 'حاسوب محمول' },
    description: { en: 'A new or replacement laptop.', ar: 'حاسوب محمول جديد أو بديل.' },
    category: 'IT',
    icon: 'laptop',
    content: () => ({
      form: {
        fields: [
          {
            key: 'kind',
            type: 'select',
            label: { en: 'Request', ar: 'الطلب' },
            required: true,
            options: [
              { value: 'new-joiner', label: { en: 'New joiner', ar: 'موظف جديد' } },
              { value: 'replacement', label: { en: 'Replacement', ar: 'استبدال' } },
              { value: 'upgrade', label: { en: 'Upgrade', ar: 'ترقية' } },
            ],
          },
          { key: 'neededBy', type: 'date', label: { en: 'Needed by', ar: 'مطلوب بحلول' }, notInPast: true },
          REASON,
        ],
      },
      steps: [MANAGER_STEP, { kind: 'FULFILLMENT', name: { en: 'Prepare and hand over', ar: 'التجهيز والتسليم' } }],
      attachments: { requirement: 'NONE', maxFiles: 0 },
      effects: {},
      notifications: NOTIFY,
    }),
  },
  {
    key: 'software_access',
    name: { en: 'Software access', ar: 'صلاحية برنامج' },
    description: { en: 'Access to an application or system.', ar: 'صلاحية الوصول إلى تطبيق أو نظام.' },
    category: 'ACCESS',
    icon: 'key',
    content: (role) => ({
      form: {
        fields: [
          { key: 'system', type: 'text', label: { en: 'System', ar: 'النظام' }, required: true, maxLength: 200 },
          {
            key: 'level',
            type: 'select',
            label: { en: 'Access level', ar: 'مستوى الصلاحية' },
            required: true,
            options: [
              { value: 'read', label: { en: 'Read', ar: 'قراءة' } },
              { value: 'write', label: { en: 'Write', ar: 'كتابة' } },
              { value: 'admin', label: { en: 'Administrator', ar: 'مسؤول' } },
            ],
          },
          { key: 'project', type: 'project', label: { en: 'Project', ar: 'المشروع' } },
          REASON,
        ],
      },
      steps: [
        MANAGER_STEP,
        {
          kind: 'APPROVAL',
          name: { en: 'Project technical approval', ar: 'الموافقة الفنية للمشروع' },
          mode: 'ANY_ONE',
          approver: { type: 'TECHNICAL_MANAGER', projectField: 'project' },
          condition: { match: 'all', rules: [{ field: 'project', op: 'isSet' }] },
          slaHours: 24,
        },
        {
          kind: 'APPROVAL',
          name: { en: 'Administrator access approval', ar: 'موافقة صلاحية المسؤول' },
          mode: 'ANY_ONE',
          approver: { type: 'ROLE', roleId: role('ORG_ADMIN') },
          condition: { match: 'all', rules: [{ field: 'level', op: 'eq', value: 'admin' }] },
          slaHours: 24,
        },
        { kind: 'FULFILLMENT', name: { en: 'Grant access', ar: 'منح الصلاحية' } },
      ],
      attachments: { requirement: 'NONE', maxFiles: 0 },
      effects: {},
      notifications: NOTIFY,
    }),
  },
  {
    key: 'purchase',
    name: { en: 'Purchase', ar: 'شراء' },
    description: { en: 'Buy goods or services.', ar: 'شراء سلع أو خدمات.' },
    category: 'FINANCE',
    icon: 'shopping-cart',
    content: (role) => ({
      form: {
        fields: [
          { key: 'item', type: 'text', label: { en: 'Item', ar: 'البند' }, required: true, maxLength: 200 },
          {
            key: 'amount',
            type: 'money',
            label: { en: 'Estimated amount', ar: 'المبلغ التقديري' },
            currency: 'EGP',
            required: true,
            min: 1,
          },
          { key: 'supplier', type: 'text', label: { en: 'Supplier', ar: 'المورد' }, maxLength: 200 },
          { key: 'project', type: 'project', label: { en: 'Project', ar: 'المشروع' } },
          REASON,
        ],
      },
      steps: [
        MANAGER_STEP,
        {
          kind: 'APPROVAL',
          name: { en: 'Department approval', ar: 'موافقة القسم' },
          mode: 'ANY_ONE',
          approver: { type: 'DEPARTMENT_MANAGER' },
          condition: { match: 'all', rules: [{ field: 'amount', op: 'gte', value: 10_000 }] },
          slaHours: 48,
        },
        {
          kind: 'APPROVAL',
          name: { en: 'Management sign-off', ar: 'اعتماد الإدارة' },
          mode: 'ALL',
          approver: { type: 'ROLE', roleId: role('GENERAL_MANAGER') },
          condition: { match: 'all', rules: [{ field: 'amount', op: 'gte', value: 100_000 }] },
          slaHours: 72,
        },
        { kind: 'FULFILLMENT', name: { en: 'Place the order', ar: 'تنفيذ الطلب' } },
      ],
      attachments: { requirement: 'OPTIONAL', maxFiles: 5 },
      effects: {},
      notifications: NOTIFY,
    }),
  },
  {
    key: 'business_mission',
    name: { en: 'Business mission', ar: 'مأمورية عمل' },
    description: { en: 'Travel or on-site work away from the office.', ar: 'سفر أو عمل ميداني خارج المكتب.' },
    category: 'OPERATIONS',
    icon: 'plane',
    content: () => ({
      form: {
        fields: [
          {
            key: 'destination',
            type: 'text',
            label: { en: 'Destination', ar: 'الوجهة' },
            required: true,
            maxLength: 200,
          },
          {
            key: 'dates',
            type: 'date_range',
            label: { en: 'Dates', ar: 'التواريخ' },
            required: true,
            maxDays: 30,
          },
          { key: 'project', type: 'project', label: { en: 'Project', ar: 'المشروع' } },
          { ...REASON, key: 'purpose', label: { en: 'Purpose', ar: 'الغرض' } },
        ],
      },
      steps: [
        MANAGER_STEP,
        {
          kind: 'APPROVAL',
          name: { en: 'Project manager approval', ar: 'موافقة مدير المشروع' },
          mode: 'ANY_ONE',
          approver: { type: 'PROJECT_MANAGER', projectField: 'project' },
          condition: { match: 'all', rules: [{ field: 'project', op: 'isSet' }] },
          slaHours: 24,
        },
      ],
      attachments: { requirement: 'OPTIONAL', maxFiles: 3 },
      effects: { attendance: { mode: 'BUSINESS_MISSION', dateField: 'dates' } },
      notifications: NOTIFY,
    }),
  },
  {
    key: 'short_permission',
    name: { en: 'Short permission', ar: 'إذن قصير' },
    description: {
      en: 'Arrive late or leave early for a few hours on one day.',
      ar: 'الحضور متأخرًا أو الانصراف مبكرًا لبضع ساعات في يوم واحد.',
    },
    category: 'HR',
    icon: 'clock',
    content: () => ({
      form: {
        fields: [
          { key: 'date', type: 'date', label: { en: 'Date', ar: 'التاريخ' }, required: true },
          { key: 'fromTime', type: 'time', label: { en: 'From', ar: 'من' }, required: true },
          { key: 'toTime', type: 'time', label: { en: 'To', ar: 'إلى' }, required: true },
          REASON,
        ],
      },
      steps: [MANAGER_STEP],
      attachments: { requirement: 'NONE', maxFiles: 0 },
      effects: {
        attendance: { mode: 'SHORT_LEAVE', dateField: 'date', fromTimeField: 'fromTime', toTimeField: 'toTime' },
      },
      notifications: NOTIFY,
    }),
  },
  {
    key: ATTENDANCE_CORRECTION_TYPE_KEY,
    name: { en: 'Attendance correction', ar: 'تصحيح الحضور' },
    description: {
      en: 'Correct a missing or wrong check-in or check-out. Submitted from the attendance page.',
      ar: 'تصحيح تسجيل حضور أو انصراف ناقص أو خاطئ. يُقدَّم من صفحة الحضور.',
    },
    category: 'HR',
    icon: 'clock',
    content: () => correctionTypeContent(),
  },
];

/** Types offered by the request catalog (the reserved correction type is reached from attendance only). */
export const DEMO_REQUEST_TYPE_KEYS: readonly string[] = SEED_TYPES.map((type) => type.key).filter(
  (key) => key !== ATTENDANCE_CORRECTION_TYPE_KEY,
);

function seedContent(type: SeedType, role: (key: SystemRoleKey) => string): WorkflowContent {
  const content = workflowContentSchema.parse(type.content(role));
  const issues = workflowPublishIssues(content, type.key);
  if (issues.length > 0) {
    throw new Error(
      `Seed request type ${type.key} is not publishable: ${issues.map((issue) => `${issue.path} ${issue.code}`).join(', ')}`,
    );
  }
  return content;
}

export async function seedRequests(
  tx: Prisma.TransactionClient,
  organizationId: string,
  roleIds: Readonly<Record<SystemRoleKey, string>>,
): Promise<{ requestTypesCreated: number }> {
  const role = (key: SystemRoleKey): string => roleIds[key];
  let requestTypesCreated = 0;
  for (const seed of SEED_TYPES) {
    const existing = await tx.requestType.findFirst({ where: { organizationId, key: seed.key }, select: { id: true } });
    if (existing !== null) continue;
    const content = seedContent(seed, role);
    const meta = createRequestTypeSchema.parse({
      key: seed.key,
      name: seed.name,
      description: seed.description,
      category: seed.category,
      icon: seed.icon,
    });
    const type = await tx.requestType.create({
      data: {
        organizationId,
        key: meta.key,
        name: meta.name,
        description: seed.description,
        category: meta.category,
        icon: meta.icon,
        active: true,
      },
      select: { id: true },
    });
    const definition = await tx.workflowDefinition.create({
      data: { organizationId, requestTypeId: type.id },
      select: { id: true },
    });
    const version = await tx.workflowVersion.create({
      data: { organizationId, definitionId: definition.id, number: 1, ...versionColumns(content) },
      select: { id: true },
    });
    await tx.workflowStep.createMany({ data: stepRows(organizationId, version.id, content.steps) });
    await tx.workflowVersion.updateMany({
      where: { organizationId, id: version.id, status: 'DRAFT' },
      data: { status: 'PUBLISHED', publishedAt: new Date() },
    });
    await recordAudit(tx, organizationId, {
      action: 'request_type.created',
      entityType: 'request_type',
      entityId: type.id,
      actor: { type: 'SYSTEM' },
      metadata: { source: 'dev-seed', key: seed.key, category: seed.category, requesterRoleIds: [] },
    });
    await recordAudit(tx, organizationId, {
      action: 'workflow.published',
      entityType: 'workflow_version',
      entityId: version.id,
      actor: { type: 'SYSTEM' },
      metadata: { source: 'dev-seed', requestTypeId: type.id, number: 1, retiredVersion: null },
    });
    requestTypesCreated += 1;
  }
  return { requestTypesCreated };
}
