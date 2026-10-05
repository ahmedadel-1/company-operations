import { describe, expect, it } from 'vitest';

import { formSchemaSchema, workflowContentSchema } from '@company-ops/validation';
import type { Condition, FormSchema, WorkflowContent } from '@company-ops/validation';

import { evaluateCondition, evaluateRule } from '../../src/modules/requests/engine/conditions.js';
import { isIsoDate, validateFormData, visibleFieldKeys } from '../../src/modules/requests/engine/form.js';
import {
  attendanceEffect,
  fulfillmentOrders,
  nextInRoute,
  planRoute,
  progressAfterApproval,
  requestDates,
  resolveApprovers,
  stepOutcome,
  workflowPublishIssues,
} from '../../src/modules/requests/engine/workflow.js';
import type { ApproverDirectory, EngineStep } from '../../src/modules/requests/engine/workflow.js';

const label = (en: string) => ({ en });

const purchaseForm: FormSchema = formSchemaSchema.parse({
  fields: [
    { key: 'item', type: 'text', label: label('Item'), required: true, maxLength: 120 },
    { key: 'amount', type: 'money', label: label('Amount'), currency: 'USD', required: true, min: 0 },
    { key: 'urgent', type: 'boolean', label: label('Urgent') },
    {
      key: 'urgency',
      type: 'textarea',
      label: label('Why urgent'),
      required: true,
      visibleWhen: { match: 'all', rules: [{ field: 'urgent', op: 'eq', value: true }] },
    },
    {
      key: 'kind',
      type: 'select',
      label: label('Kind'),
      options: [
        { value: 'hardware', label: label('Hardware') },
        { value: 'software', label: label('Software') },
      ],
    },
    {
      key: 'tags',
      type: 'multiselect',
      label: label('Tags'),
      options: [
        { value: 'a', label: label('A') },
        { value: 'b', label: label('B') },
      ],
      maxItems: 2,
      minItems: 1,
    },
    { key: 'period', type: 'date_range', label: label('Period'), notInPast: true, maxDays: 10 },
    { key: 'day', type: 'date', label: label('Day') },
    { key: 'at', type: 'time', label: label('At') },
    { key: 'count', type: 'number', label: label('Count'), integer: true, max: 5 },
    { key: 'colleague', type: 'member', label: label('Colleague') },
    { key: 'project', type: 'project', label: label('Project') },
    { key: 'note', type: 'info', label: label('Read me') },
  ],
});

const TODAY = '2026-10-04';
const submit = { mode: 'submit', today: TODAY } as const;
const draft = { mode: 'draft', today: TODAY } as const;
const codes = (result: ReturnType<typeof validateFormData>) =>
  Object.fromEntries(result.issues.map((issue) => [issue.path, issue.code]));

describe('form schema meta-validation', () => {
  it('rejects duplicate keys, duplicate options, inverted limits and unknown properties', () => {
    const result = formSchemaSchema.safeParse({
      fields: [
        { key: 'a', type: 'text', label: label('A'), minLength: 10, maxLength: 2 },
        { key: 'a', type: 'number', label: label('B'), min: 5, max: 1 },
        {
          key: 's',
          type: 'select',
          label: label('S'),
          options: [
            { value: 'x', label: label('X') },
            { value: 'x', label: label('Y') },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual(
      expect.arrayContaining([
        'duplicate field key',
        'minLength exceeds maxLength',
        'min exceeds max',
        'duplicate option value',
      ]),
    );
    expect(
      formSchemaSchema.safeParse({ fields: [{ key: 'a', type: 'text', label: label('A'), script: 'alert(1)' }] })
        .success,
    ).toBe(false);
    expect(formSchemaSchema.safeParse({ fields: [{ key: 'a', type: 'javascript', label: label('A') }] }).success).toBe(
      false,
    );
  });

  it('rejects conditions on unknown fields, on itself, and with values that do not fit the field', () => {
    const base = { key: 'a', type: 'number', label: label('A') };
    const cases: Condition[] = [
      { match: 'all', rules: [{ field: 'missing', op: 'isSet' }] },
      { match: 'all', rules: [{ field: 'b', op: 'gt', value: 'ten' }] },
      { match: 'all', rules: [{ field: 'b', op: 'in', value: ['x'] }] },
      { match: 'all', rules: [{ field: 'b', op: 'isSet', value: 1 }] },
      { match: 'all', rules: [{ field: 'c', op: 'eq', value: 'nope' }] },
      { match: 'all', rules: [{ field: 'z', op: 'isSet' }] },
    ];
    for (const visibleWhen of cases) {
      const parsed = formSchemaSchema.safeParse({
        fields: [
          { ...base, key: 'b' },
          { key: 'c', type: 'select', label: label('C'), options: [{ value: 'yes', label: label('Yes') }] },
          { key: 'z', type: 'text', label: label('Z'), visibleWhen },
        ],
      });
      expect(parsed.success, JSON.stringify(visibleWhen)).toBe(false);
    }
  });

  it('caps the number of fields and condition rules and rejects pathological keys', () => {
    const fields = Array.from({ length: 41 }, (_, index) => ({
      key: `f${String(index)}`,
      type: 'text',
      label: label('F'),
    }));
    expect(formSchemaSchema.safeParse({ fields }).success).toBe(false);
    const rules = Array.from({ length: 11 }, () => ({ field: 'f0', op: 'isSet' }));
    expect(
      formSchemaSchema.safeParse({
        fields: [fields[0], { key: 'x', type: 'text', label: label('X'), visibleWhen: { match: 'any', rules } }],
      }).success,
    ).toBe(false);
    expect(
      formSchemaSchema.safeParse({ fields: [{ key: '__proto__', type: 'text', label: label('P') }] }).success,
    ).toBe(false);
    expect(formSchemaSchema.safeParse({ fields: [{ key: 'a b', type: 'text', label: label('P') }] }).success).toBe(
      false,
    );
  });
});

describe('form data validation', () => {
  it('accepts valid data and normalizes it', () => {
    const result = validateFormData(
      purchaseForm,
      {
        item: '  Laptop stand ',
        amount: 120.5,
        urgent: false,
        kind: 'hardware',
        tags: ['a'],
        period: { start: '2026-10-05', end: '2026-10-07' },
        day: '2026-11-01',
        at: '09:30',
        count: 2,
        colleague: '0199A0B0-0000-7000-8000-000000000001',
        project: '0199a0b0-0000-7000-8000-000000000002',
      },
      submit,
    );
    expect(result.issues).toEqual([]);
    expect(result.data.item).toBe('Laptop stand');
    expect(result.memberIds).toEqual(['0199a0b0-0000-7000-8000-000000000001']);
    expect(result.projectIds).toEqual(['0199a0b0-0000-7000-8000-000000000002']);
  });

  it('requires visible required fields on submit only', () => {
    expect(codes(validateFormData(purchaseForm, {}, submit))).toMatchObject({
      'formData.item': 'required',
      'formData.amount': 'required',
    });
    expect(validateFormData(purchaseForm, {}, draft).issues).toEqual([]);
  });

  it('applies conditional visibility: hidden values are rejected, shown required fields enforced', () => {
    const shown = validateFormData(purchaseForm, { item: 'X', amount: 1, urgent: true }, submit);
    expect(codes(shown)).toEqual({ 'formData.urgency': 'required' });
    const hidden = validateFormData(purchaseForm, { item: 'X', amount: 1, urgent: false, urgency: 'smuggled' }, submit);
    expect(codes(hidden)).toEqual({ 'formData.urgency': 'hidden' });
    expect(hidden.data.urgency).toBeUndefined();
    expect([...visibleFieldKeys(purchaseForm, { urgent: true })]).toContain('urgency');
  });

  it('rejects unknown keys, values for info fields and wrong types', () => {
    const result = validateFormData(
      purchaseForm,
      {
        item: 'X',
        amount: 1,
        extra: 'x',
        note: 'x',
        kind: 'weapons',
        count: 1.5,
        at: '25:00',
        colleague: 'not-a-uuid',
        urgent: 'yes',
      },
      submit,
    );
    expect(codes(result)).toEqual({
      'formData.extra': 'unknown',
      'formData.note': 'not_allowed',
      'formData.kind': 'not_allowed',
      'formData.count': 'invalid',
      'formData.at': 'invalid',
      'formData.colleague': 'invalid',
      'formData.urgent': 'invalid',
    });
  });

  it('enforces lengths, ranges, money precision, dates and list limits', () => {
    const result = validateFormData(
      purchaseForm,
      {
        item: 'x'.repeat(121),
        amount: 10.555,
        count: 6,
        tags: ['a', 'a'],
        period: { start: '2026-10-03', end: '2026-10-05' },
        day: '2026-02-30',
      },
      submit,
    );
    expect(codes(result)).toEqual({
      'formData.item': 'too_long',
      'formData.amount': 'invalid',
      'formData.count': 'too_large',
      'formData.tags': 'invalid',
      'formData.period': 'in_past',
      'formData.day': 'invalid',
    });
    expect(
      codes(validateFormData(purchaseForm, { period: { start: '2026-10-09', end: '2026-10-05' } }, draft)),
    ).toEqual({ 'formData.period': 'range' });
    expect(
      codes(validateFormData(purchaseForm, { period: { start: '2026-10-05', end: '2026-10-20' } }, draft)),
    ).toEqual({ 'formData.period': 'too_large' });
    expect(codes(validateFormData(purchaseForm, { amount: -1 }, draft))).toEqual({ 'formData.amount': 'too_small' });
  });

  it('treats a required boolean as an acknowledgement that must be true', () => {
    const form = formSchemaSchema.parse({
      fields: [{ key: 'agree', type: 'boolean', label: label('Agree'), required: true }],
    });
    expect(codes(validateFormData(form, { agree: false }, submit))).toEqual({ 'formData.agree': 'required' });
    expect(validateFormData(form, { agree: true }, submit).issues).toEqual([]);
  });

  it('validates ISO calendar dates strictly', () => {
    expect(isIsoDate('2026-10-04')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-1-01')).toBe(false);
    expect(isIsoDate(20261004)).toBe(false);
  });
});

describe('conditions', () => {
  const data = { amount: 6000, kind: 'hardware', tags: ['a', 'b'], day: '2026-10-10', flag: true };

  it('evaluates every operator', () => {
    expect(evaluateRule({ field: 'amount', op: 'gt', value: 5000 }, data)).toBe(true);
    expect(evaluateRule({ field: 'amount', op: 'gte', value: 6000 }, data)).toBe(true);
    expect(evaluateRule({ field: 'amount', op: 'lt', value: 6000 }, data)).toBe(false);
    expect(evaluateRule({ field: 'amount', op: 'lte', value: 6000 }, data)).toBe(true);
    expect(evaluateRule({ field: 'kind', op: 'eq', value: 'hardware' }, data)).toBe(true);
    expect(evaluateRule({ field: 'kind', op: 'neq', value: 'hardware' }, data)).toBe(false);
    expect(evaluateRule({ field: 'kind', op: 'in', value: ['software', 'hardware'] }, data)).toBe(true);
    expect(evaluateRule({ field: 'tags', op: 'in', value: ['b'] }, data)).toBe(true);
    expect(evaluateRule({ field: 'tags', op: 'notIn', value: ['b'] }, data)).toBe(false);
    expect(evaluateRule({ field: 'day', op: 'gte', value: '2026-10-01' }, data)).toBe(true);
    expect(evaluateRule({ field: 'flag', op: 'eq', value: true }, data)).toBe(true);
    expect(evaluateRule({ field: 'flag', op: 'isSet' }, data)).toBe(true);
  });

  it('treats missing values as unset', () => {
    expect(evaluateRule({ field: 'none', op: 'eq', value: 1 }, data)).toBe(false);
    expect(evaluateRule({ field: 'none', op: 'gt', value: 1 }, data)).toBe(false);
    expect(evaluateRule({ field: 'none', op: 'neq', value: 1 }, data)).toBe(true);
    expect(evaluateRule({ field: 'none', op: 'notIn', value: ['x'] }, data)).toBe(true);
    expect(evaluateRule({ field: 'none', op: 'isNotSet' }, data)).toBe(true);
    expect(evaluateRule({ field: 'none', op: 'in', value: ['x'] }, data)).toBe(false);
  });

  it('never matches values of a different type', () => {
    expect(evaluateRule({ field: 'amount', op: 'eq', value: '6000' }, data)).toBe(false);
    expect(evaluateRule({ field: 'amount', op: 'gt', value: '1' }, data)).toBe(false);
  });

  it('combines rules with all / any; an absent condition holds', () => {
    const rules = [
      { field: 'amount', op: 'gt' as const, value: 5000 },
      { field: 'kind', op: 'eq' as const, value: 'software' },
    ];
    expect(evaluateCondition({ match: 'all', rules }, data)).toBe(false);
    expect(evaluateCondition({ match: 'any', rules }, data)).toBe(true);
    expect(evaluateCondition(null, data)).toBe(true);
    expect(evaluateCondition(undefined, data)).toBe(true);
  });
});

const step = (order: number, overrides: Partial<EngineStep> = {}): EngineStep => ({
  order,
  kind: 'APPROVAL',
  mode: 'ANY_ONE',
  approverType: 'DIRECT_MANAGER',
  approverMemberId: null,
  approverRoleId: null,
  projectField: null,
  condition: null,
  slaHours: null,
  ...overrides,
});

describe('route planning and progression', () => {
  const threshold: Condition = { match: 'all', rules: [{ field: 'amount', op: 'gt', value: 5000 }] };
  const steps = [
    step(1),
    step(2, { approverType: 'ROLE', approverRoleId: 'finance', condition: threshold }),
    step(3, { approverType: 'MEMBER', approverMemberId: 'gm' }),
    step(4, { kind: 'FULFILLMENT', approverType: null }),
  ];
  const byOrder = new Map(steps.map((item) => [item.order, item]));

  it('selects the conditional route above the threshold and skips it below', () => {
    expect(planRoute(steps, { amount: 6000 })).toEqual([1, 2, 3, 4]);
    expect(planRoute(steps, { amount: 100 })).toEqual([1, 3, 4]);
    expect(planRoute([...steps].reverse(), { amount: 100 })).toEqual([1, 3, 4]);
  });

  it('walks the route and ends approval before fulfillment', () => {
    const route = [1, 3, 4];
    expect(nextInRoute(route, null)).toBe(1);
    expect(nextInRoute(route, 1)).toBe(3);
    expect(nextInRoute(route, 4)).toBeNull();
    expect(progressAfterApproval(route, byOrder, 1)).toEqual({ kind: 'ACTIVATE_APPROVAL', order: 3 });
    expect(progressAfterApproval(route, byOrder, 3)).toEqual({ kind: 'APPROVED', fulfillmentOrders: [4] });
    expect(progressAfterApproval([1], byOrder, 1)).toEqual({ kind: 'APPROVED', fulfillmentOrders: [] });
    expect(fulfillmentOrders(route, byOrder)).toEqual([4]);
  });
});

describe('approver resolution', () => {
  const directory: ApproverDirectory = {
    requesterMemberId: 'requester',
    directManagerMemberId: 'manager',
    departmentManagerChain: ['requester', null, 'disabled', 'head'],
    teamLeadMemberIds: ['lead-b', 'lead-a', 'requester', 'lead-a'],
    projects: new Map([['p1', { managerMemberId: 'pm', technicalManagerMemberId: 'requester' }]]),
    roleHolders: new Map([
      ['finance', ['fin-2', 'fin-1', 'requester', 'disabled']],
      ['big', Array.from({ length: 30 }, (_, index) => `m${String(index).padStart(2, '0')}`)],
    ]),
    eligibleMemberIds: new Set([
      'manager',
      'head',
      'lead-a',
      'lead-b',
      'pm',
      'fin-1',
      'fin-2',
      'gm',
      'requester',
      ...Array.from({ length: 30 }, (_, index) => `m${String(index).padStart(2, '0')}`),
    ]),
  };

  it('resolves each rule type', () => {
    expect(resolveApprovers(step(1), {}, directory)).toEqual({ ok: true, memberIds: ['manager'] });
    expect(resolveApprovers(step(1, { approverType: 'DEPARTMENT_MANAGER' }), {}, directory)).toEqual({
      ok: true,
      memberIds: ['head'],
    });
    expect(resolveApprovers(step(1, { approverType: 'TEAM_LEAD' }), {}, directory)).toEqual({
      ok: true,
      memberIds: ['lead-a', 'lead-b'],
    });
    expect(
      resolveApprovers(
        step(1, { approverType: 'PROJECT_MANAGER', projectField: 'project' }),
        { project: 'p1' },
        directory,
      ),
    ).toEqual({
      ok: true,
      memberIds: ['pm'],
    });
    expect(resolveApprovers(step(1, { approverType: 'ROLE', approverRoleId: 'finance' }), {}, directory)).toEqual({
      ok: true,
      memberIds: ['fin-1', 'fin-2'],
    });
    expect(resolveApprovers(step(1, { approverType: 'MEMBER', approverMemberId: 'gm' }), {}, directory)).toEqual({
      ok: true,
      memberIds: ['gm'],
    });
  });

  it('never resolves the requester (no self-approval) or ineligible members', () => {
    expect(resolveApprovers(step(1, { approverType: 'MEMBER', approverMemberId: 'requester' }), {}, directory)).toEqual(
      { ok: false, reason: 'NO_CANDIDATE' },
    );
    expect(
      resolveApprovers(
        step(1, { approverType: 'TECHNICAL_MANAGER', projectField: 'project' }),
        { project: 'p1' },
        directory,
      ),
    ).toEqual({
      ok: false,
      reason: 'NO_CANDIDATE',
    });
    expect(resolveApprovers(step(1, { approverType: 'MEMBER', approverMemberId: 'disabled' }), {}, directory)).toEqual({
      ok: false,
      reason: 'NO_CANDIDATE',
    });
    expect(resolveApprovers(step(1), {}, { ...directory, directManagerMemberId: 'requester' })).toEqual({
      ok: false,
      reason: 'NO_CANDIDATE',
    });
  });

  it('reports no approver instead of approving automatically', () => {
    expect(resolveApprovers(step(1), {}, { ...directory, directManagerMemberId: null })).toEqual({
      ok: false,
      reason: 'NO_CANDIDATE',
    });
    expect(
      resolveApprovers(step(1, { approverType: 'PROJECT_MANAGER', projectField: 'project' }), {}, directory),
    ).toEqual({ ok: false, reason: 'NO_CANDIDATE' });
    expect(
      resolveApprovers(
        step(1, { approverType: 'PROJECT_MANAGER', projectField: 'project' }),
        { project: 'unknown' },
        directory,
      ),
    ).toEqual({
      ok: false,
      reason: 'NO_CANDIDATE',
    });
    expect(resolveApprovers(step(1, { approverType: 'ROLE', approverRoleId: 'none' }), {}, directory)).toEqual({
      ok: false,
      reason: 'NO_CANDIDATE',
    });
    expect(resolveApprovers(step(1, { approverType: null }), {}, directory)).toEqual({
      ok: false,
      reason: 'NO_CANDIDATE',
    });
  });

  it('caps large role steps: ANY_ONE takes a deterministic subset, ALL refuses', () => {
    const anyOne = resolveApprovers(step(1, { approverType: 'ROLE', approverRoleId: 'big' }), {}, directory);
    expect(anyOne.ok && anyOne.memberIds.length).toBe(25);
    expect(anyOne.ok && anyOne.memberIds[0]).toBe('m00');
    expect(
      resolveApprovers(step(1, { approverType: 'ROLE', approverRoleId: 'big', mode: 'ALL' }), {}, directory),
    ).toEqual({ ok: false, reason: 'TOO_MANY' });
  });
});

describe('step decisions', () => {
  it('ANY_ONE completes on the first approval and supersedes the rest', () => {
    expect(
      stepOutcome('ANY_ONE', [
        { id: 'a', status: 'APPROVED' },
        { id: 'b', status: 'PENDING' },
      ]),
    ).toEqual({ kind: 'COMPLETED', supersede: ['b'] });
  });

  it('ALL waits for every live assignment', () => {
    expect(
      stepOutcome('ALL', [
        { id: 'a', status: 'APPROVED' },
        { id: 'b', status: 'PENDING' },
      ]),
    ).toEqual({ kind: 'OPEN' });
    expect(
      stepOutcome('ALL', [
        { id: 'a', status: 'APPROVED' },
        { id: 'b', status: 'APPROVED' },
      ]),
    ).toEqual({ kind: 'COMPLETED', supersede: [] });
    expect(
      stepOutcome('ALL', [
        { id: 'a', status: 'APPROVED' },
        { id: 'b', status: 'SUPERSEDED' },
        { id: 'c', status: 'APPROVED' },
      ]),
    ).toEqual({ kind: 'COMPLETED', supersede: [] });
  });

  it('any rejection rejects the step in both modes', () => {
    expect(
      stepOutcome('ALL', [
        { id: 'a', status: 'APPROVED' },
        { id: 'b', status: 'REJECTED' },
        { id: 'c', status: 'PENDING' },
      ]),
    ).toEqual({
      kind: 'REJECTED',
      supersede: ['c'],
    });
    expect(
      stepOutcome('ANY_ONE', [
        { id: 'a', status: 'REJECTED' },
        { id: 'b', status: 'PENDING' },
      ]),
    ).toEqual({ kind: 'REJECTED', supersede: ['b'] });
  });

  it('stays open with nothing decided or nobody assigned', () => {
    expect(stepOutcome('ANY_ONE', [{ id: 'a', status: 'PENDING' }])).toEqual({ kind: 'OPEN' });
    expect(stepOutcome('ALL', [])).toEqual({ kind: 'OPEN' });
    expect(stepOutcome('ANY_ONE', [{ id: 'a', status: 'SUPERSEDED' }])).toEqual({ kind: 'OPEN' });
  });
});

const content = (overrides: Partial<WorkflowContent> = {}): WorkflowContent =>
  workflowContentSchema.parse({
    form: {
      fields: [
        { key: 'dates', type: 'date_range', label: label('Dates'), required: true },
        { key: 'project', type: 'project', label: label('Project') },
        { key: 'amount', type: 'money', label: label('Amount'), currency: 'USD' },
      ],
    },
    steps: [{ kind: 'APPROVAL', name: label('Manager'), approver: { type: 'DIRECT_MANAGER' } }],
    attachments: { requirement: 'NONE', maxFiles: 0 },
    effects: {},
    notifications: { emailApprovers: true, emailRequester: true },
    ...overrides,
  });

describe('publish validation', () => {
  it('accepts a minimal valid workflow', () => {
    expect(workflowPublishIssues(content())).toEqual([]);
  });

  it('requires an unconditional approval step first and no approval after fulfillment', () => {
    const issues = workflowPublishIssues(
      content({
        steps: [
          { kind: 'FULFILLMENT', name: label('Ship') },
          { kind: 'APPROVAL', name: label('Manager'), approver: { type: 'DIRECT_MANAGER' } },
        ],
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'steps.0', code: 'first_step_unconditional_approval' },
        { path: 'steps.1', code: 'approval_after_fulfillment' },
      ]),
    );
    const conditional = workflowPublishIssues(
      content({
        steps: [
          {
            kind: 'APPROVAL',
            name: label('Manager'),
            approver: { type: 'DIRECT_MANAGER' },
            condition: { match: 'all', rules: [{ field: 'amount', op: 'gt', value: 1 }] },
          },
        ],
      }),
    );
    expect(conditional).toEqual([{ path: 'steps.0', code: 'first_step_unconditional_approval' }]);
    expect(workflowPublishIssues(content({ steps: [{ kind: 'FULFILLMENT', name: label('Ship') }] }))).toEqual(
      expect.arrayContaining([{ path: 'steps', code: 'approval_required' }]),
    );
  });

  it('checks approver rule parameters and project fields', () => {
    const issues = workflowPublishIssues(
      content({
        steps: [
          { kind: 'APPROVAL', name: label('A'), approver: { type: 'DIRECT_MANAGER' } },
          { kind: 'APPROVAL', name: label('B'), approver: { type: 'MEMBER' } },
          {
            kind: 'APPROVAL',
            name: label('C'),
            approver: { type: 'ROLE', memberId: '0199a0b0-0000-7000-8000-000000000001' },
          },
          { kind: 'APPROVAL', name: label('D'), approver: { type: 'PROJECT_MANAGER', projectField: 'amount' } },
          { kind: 'APPROVAL', name: label('E') },
          { kind: 'FULFILLMENT', name: label('F'), approver: { type: 'DIRECT_MANAGER' }, mode: 'ALL', slaHours: 4 },
        ],
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'steps.1.approver.memberId', code: 'required' },
        { path: 'steps.2.approver.memberId', code: 'not_allowed' },
        { path: 'steps.2.approver.roleId', code: 'required' },
        { path: 'steps.3.approver.projectField', code: 'invalid' },
        { path: 'steps.4.approver', code: 'required' },
        { path: 'steps.5.approver', code: 'not_allowed' },
        { path: 'steps.5.mode', code: 'not_allowed' },
        { path: 'steps.5.slaHours', code: 'not_allowed' },
      ]),
    );
  });

  it('rejects step conditions on unknown fields and invalid effect fields', () => {
    const issues = workflowPublishIssues(
      content({
        steps: [
          { kind: 'APPROVAL', name: label('A'), approver: { type: 'DIRECT_MANAGER' } },
          {
            kind: 'APPROVAL',
            name: label('B'),
            approver: { type: 'DIRECT_MANAGER' },
            condition: { match: 'any', rules: [{ field: 'ghost', op: 'isSet' }] },
          },
        ],
        effects: { attendance: { mode: 'LEAVE', dateField: 'amount' } },
        attachments: { requirement: 'REQUIRED', maxFiles: 0 },
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: 'steps.1.condition.rules.0', code: 'invalid' },
        { path: 'effects.attendance.dateField', code: 'invalid' },
        { path: 'attachments.maxFiles', code: 'too_small' },
      ]),
    );
  });
});

describe('effects and dates', () => {
  const effects = { attendance: { mode: 'LEAVE' as const, dateField: 'dates' } };
  const form = content().form;

  it('derives the attendance effect from the declared date field', () => {
    expect(attendanceEffect(effects, { dates: { start: '2026-10-05', end: '2026-10-06' } })).toEqual({
      mode: 'LEAVE',
      startsOn: '2026-10-05',
      endsOn: '2026-10-06',
      startsAtMinute: null,
      endsAtMinute: null,
    });
    expect(attendanceEffect({ attendance: { mode: 'REMOTE', dateField: 'day' } }, { day: '2026-10-05' })).toEqual({
      mode: 'REMOTE',
      startsOn: '2026-10-05',
      endsOn: '2026-10-05',
      startsAtMinute: null,
      endsAtMinute: null,
    });
    expect(attendanceEffect({}, { dates: { start: '2026-10-05', end: '2026-10-06' } })).toBeNull();
  });

  it('keeps a short permission time window only when it is a forward range', () => {
    const shortLeave = {
      attendance: { mode: 'SHORT_LEAVE' as const, dateField: 'date', fromTimeField: 'fromTime', toTimeField: 'toTime' },
    };
    expect(attendanceEffect(shortLeave, { date: '2026-10-05', fromTime: '09:00', toTime: '10:30' })).toMatchObject({
      mode: 'SHORT_LEAVE',
      startsAtMinute: 540,
      endsAtMinute: 630,
    });
    expect(attendanceEffect(shortLeave, { date: '2026-10-05', fromTime: '10:30', toTime: '09:00' })).toMatchObject({
      startsAtMinute: null,
      endsAtMinute: null,
    });
  });

  it('derives list dates from the effect field or the first dated field', () => {
    expect(requestDates(form, {}, { dates: { start: '2026-10-05', end: '2026-10-07' } })).toEqual({
      startsOn: '2026-10-05',
      endsOn: '2026-10-07',
    });
    expect(requestDates(form, {}, {})).toBeNull();
  });
});
