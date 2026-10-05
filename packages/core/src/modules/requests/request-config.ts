import type { Prisma } from '@company-ops/db';
import {
  conditionSchema,
  formDataSchema,
  formSchemaSchema,
  localizedLongTextSchema,
  localizedTextSchema,
  workflowEffectsSchema,
} from '@company-ops/validation';
import type { Condition, FormSchema, LocalizedText, WorkflowContent } from '@company-ops/validation';

import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { FieldValue, NormalizedData } from './engine/conditions.js';
import type { EngineStep } from './engine/workflow.js';

/**
 * Typed views of configuration stored as JSON (form schema, conditions, effects, names). Everything is
 * re-validated when read, so a row that does not match the contract fails loudly instead of being
 * interpreted loosely.
 */
function parseStored<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  what: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Stored ${what} does not match its contract.`);
  }
  return result.data;
}

export const parseForm = (value: Prisma.JsonValue): FormSchema => parseStored(formSchemaSchema, value, 'form schema');
export const parseEffects = (value: Prisma.JsonValue): WorkflowContent['effects'] =>
  parseStored(workflowEffectsSchema, value, 'effects');
export const parseLabel = (value: Prisma.JsonValue): LocalizedText => parseStored(localizedTextSchema, value, 'label');
export const parseLongLabel = (value: Prisma.JsonValue | null): LocalizedText | null =>
  value === null ? null : parseStored(localizedLongTextSchema, value, 'description');
export const parseCondition = (value: Prisma.JsonValue | null): Condition | null =>
  value === null ? null : parseStored(conditionSchema, value, 'condition');

/** Normalized form data of a submitted request (validated at submission; re-checked against the contract). */
export function storedFormData(value: Prisma.JsonValue): NormalizedData {
  const parsed = parseStored(formDataSchema, value, 'form data');
  const data: Record<string, FieldValue> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (item !== null) data[key] = item;
  }
  return data;
}

export const stepSelect = {
  id: true,
  stepOrder: true,
  kind: true,
  name: true,
  mode: true,
  approverType: true,
  approverMemberId: true,
  approverRoleId: true,
  projectField: true,
  condition: true,
  slaHours: true,
} satisfies Prisma.WorkflowStepSelect;

export type StepRow = Prisma.WorkflowStepGetPayload<{ select: typeof stepSelect }>;

export interface LoadedStep extends EngineStep {
  readonly id: string;
  readonly name: LocalizedText;
}

export function toLoadedStep(row: StepRow): LoadedStep {
  return {
    id: row.id,
    order: row.stepOrder,
    kind: row.kind,
    mode: row.mode,
    approverType: row.approverType,
    approverMemberId: row.approverMemberId,
    approverRoleId: row.approverRoleId,
    projectField: row.projectField,
    condition: parseCondition(row.condition),
    slaHours: row.slaHours,
    name: parseLabel(row.name),
  };
}

export interface LoadedVersion {
  readonly id: string;
  readonly number: number;
  readonly status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  readonly form: FormSchema;
  readonly effects: WorkflowContent['effects'];
  readonly attachments: WorkflowContent['attachments'];
  readonly notifications: WorkflowContent['notifications'];
  readonly steps: readonly LoadedStep[];
  readonly stepsByOrder: ReadonlyMap<number, LoadedStep>;
}

/** A workflow version with its parsed configuration and steps. */
export async function loadVersion(
  db: TenantDb,
  organizationId: string,
  versionId: string,
): Promise<LoadedVersion | null> {
  const row = await db.workflowVersion.findFirst({
    where: { organizationId, id: versionId },
    select: {
      id: true,
      number: true,
      status: true,
      formSchema: true,
      effects: true,
      attachmentRequirement: true,
      maxAttachments: true,
      emailApprovers: true,
      emailRequester: true,
      steps: { select: stepSelect, orderBy: { stepOrder: 'asc' } },
    },
  });
  if (row === null) {
    return null;
  }
  const steps = row.steps.map(toLoadedStep);
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    form: parseForm(row.formSchema),
    effects: parseEffects(row.effects),
    attachments: { requirement: row.attachmentRequirement, maxFiles: row.maxAttachments },
    notifications: { emailApprovers: row.emailApprovers, emailRequester: row.emailRequester },
    steps,
    stepsByOrder: new Map(steps.map((step) => [step.order, step])),
  };
}

export async function mustLoadVersion(db: TenantDb, organizationId: string, versionId: string): Promise<LoadedVersion> {
  const version = await loadVersion(db, organizationId, versionId);
  if (version === null) {
    throw new Error('Workflow version disappeared.');
  }
  return version;
}
