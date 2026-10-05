import { ATTENDANCE_CORRECTION_TYPE_KEY, workflowContentSchema } from '@company-ops/validation';
import type { AttendanceAdjustmentReason, WorkflowContent } from '@company-ops/validation';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { lockCorrectionTypeProvisioning } from '../../platform/db/sql/attendance.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import { CORRECTION_FORM_CONTRACT, workflowPublishIssues } from '../requests/engine/workflow.js';
import { stepRows, versionColumns } from '../requests/request-type-admin.service.js';

/**
 * The reserved, system-provisioned request type for attendance corrections (ADR-0022). Its form keeps
 * the fixed contract (`workDate`, `reasonCode`, `checkIn`, `checkOut`, `details`); approval follows the
 * workflow (direct manager by default), which administrators may change like any other type.
 */
/** Request form option values are lowercase; the adjustment row keeps the canonical reason code. */
export const correctionReasonOption = (reason: AttendanceAdjustmentReason): string => reason.toLowerCase();

export function correctionTypeContent(): WorkflowContent {
  return workflowContentSchema.parse({
    form: {
      fields: [
        {
          key: CORRECTION_FORM_CONTRACT.workDate,
          type: 'date',
          label: { en: 'Work date', ar: 'تاريخ العمل' },
          required: true,
        },
        {
          key: CORRECTION_FORM_CONTRACT.reasonCode,
          type: 'select',
          label: { en: 'Reason', ar: 'السبب' },
          required: true,
          options: [
            {
              value: correctionReasonOption('FORGOT_CHECK_IN'),
              label: { en: 'Forgot to check in', ar: 'نسيت تسجيل الحضور' },
            },
            {
              value: correctionReasonOption('FORGOT_CHECK_OUT'),
              label: { en: 'Forgot to check out', ar: 'نسيت تسجيل الانصراف' },
            },
            { value: correctionReasonOption('WRONG_LOCATION'), label: { en: 'Wrong location', ar: 'موقع غير صحيح' } },
            { value: correctionReasonOption('SYSTEM_ISSUE'), label: { en: 'System issue', ar: 'مشكلة في النظام' } },
            { value: correctionReasonOption('INCORRECT_TIME'), label: { en: 'Incorrect time', ar: 'وقت غير صحيح' } },
          ],
        },
        {
          key: CORRECTION_FORM_CONTRACT.checkIn,
          type: 'time',
          label: { en: 'Corrected check-in', ar: 'الحضور المصحح' },
        },
        {
          key: CORRECTION_FORM_CONTRACT.checkOut,
          type: 'time',
          label: { en: 'Corrected check-out', ar: 'الانصراف المصحح' },
        },
        {
          key: 'checkOutNextDay',
          type: 'boolean',
          label: { en: 'Check-out on the next day', ar: 'الانصراف في اليوم التالي' },
        },
        {
          key: CORRECTION_FORM_CONTRACT.details,
          type: 'textarea',
          label: { en: 'Details', ar: 'التفاصيل' },
          required: true,
          maxLength: 2000,
        },
      ],
    },
    steps: [
      {
        kind: 'APPROVAL',
        name: { en: 'Manager approval', ar: 'موافقة المدير' },
        mode: 'ANY_ONE',
        approver: { type: 'DIRECT_MANAGER' },
        slaHours: 48,
      },
    ],
    attachments: { requirement: 'NONE', maxFiles: 0 },
    effects: { attendance: { mode: 'CORRECTION', dateField: CORRECTION_FORM_CONTRACT.workDate } },
    notifications: { emailApprovers: true, emailRequester: true },
  });
}

/**
 * The organization's correction type id, provisioning it (active, one published version) when missing.
 * Serialized by an advisory lock so concurrent first submissions create it once. An existing type is
 * never changed (administrators may have edited its workflow or deactivated it).
 */
export async function ensureCorrectionType(
  tx: TenantDb,
  organizationId: string,
  source: 'on-demand' | 'dev-seed',
): Promise<{ id: string; active: boolean }> {
  const find = () =>
    tx.requestType.findFirst({
      where: { organizationId, key: ATTENDANCE_CORRECTION_TYPE_KEY },
      select: { id: true, active: true },
    });
  const existing = await find();
  if (existing !== null) return existing;
  await lockCorrectionTypeProvisioning(tx, organizationId);
  const again = await find();
  if (again !== null) return again;
  const content = correctionTypeContent();
  const issues = workflowPublishIssues(content, ATTENDANCE_CORRECTION_TYPE_KEY);
  if (issues.length > 0) {
    throw new Error(
      `The attendance correction type is not publishable: ${issues.map((issue) => issue.path).join(', ')}`,
    );
  }
  const type = await tx.requestType.create({
    data: {
      organizationId,
      key: ATTENDANCE_CORRECTION_TYPE_KEY,
      name: { en: 'Attendance correction', ar: 'تصحيح الحضور' },
      description: {
        en: 'Correct a missing or wrong check-in or check-out. Submitted from the attendance page.',
        ar: 'تصحيح تسجيل حضور أو انصراف ناقص أو خاطئ. يُقدَّم من صفحة الحضور.',
      },
      category: 'HR',
      icon: 'clock',
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
    metadata: { source, key: ATTENDANCE_CORRECTION_TYPE_KEY, category: 'HR', requesterRoleIds: [] },
  });
  await recordAudit(tx, organizationId, {
    action: 'workflow.published',
    entityType: 'workflow_version',
    entityId: version.id,
    actor: { type: 'SYSTEM' },
    metadata: { source, requestTypeId: type.id, number: 1, retiredVersion: null },
  });
  return { id: type.id, active: true };
}
