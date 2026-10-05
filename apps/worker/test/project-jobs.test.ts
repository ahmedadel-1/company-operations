import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';

import { AsyncLocalTenantContext } from '@company-ops/core';
import type {
  ActivityWriteResult,
  AttachmentService,
  DailyReportMissingCheck,
  PrismaClient,
  ProjectActivityWriter,
} from '@company-ops/core';

import {
  DELETE_ATTACHMENT_OBJECT_JOB,
  handleDeleteAttachmentObjectJob,
} from '../src/processors/maintenance/delete-attachment-object.js';
import {
  handleProjectActivityJob,
  PROJECT_ACTIVITY_RECORD_JOB,
} from '../src/processors/projects/project-activity-job.js';
import { checkMissingReports } from '../src/processors/reports/missing-reports-check.js';

const ORG = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER_ORG = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e';
const PROJECT = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const EVENT = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';
const SYSTEM = (organizationId: string) => ({ organizationId, memberId: null, userId: null });

const activityPayload = {
  projectId: PROJECT,
  occurredAt: '2026-10-02T08:00:00.000Z',
  source: 'PROJECT',
  type: 'project.status_changed',
  entityType: 'project',
  entityId: PROJECT,
  summaryParams: { from: 'PLANNING', to: 'ACTIVE' },
  actorMemberId: null,
};

const job = (eventType: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  eventId: EVENT,
  organizationId: ORG,
  eventType,
  payload,
  ...overrides,
});

function recordingWriter(tenant: AsyncLocalTenantContext, result: ActivityWriteResult) {
  const calls: { context: unknown; eventId: string }[] = [];
  const writer = {
    record: (eventId: string) => {
      calls.push({ context: tenant.get(), eventId });
      return Promise.resolve(result);
    },
  } as unknown as ProjectActivityWriter;
  return { writer, calls };
}

describe('handleProjectActivityJob', () => {
  it('records the entry in a system context of the event organization, keyed by the event id', async () => {
    const tenant = new AsyncLocalTenantContext();
    const { writer, calls } = recordingWriter(tenant, { kind: 'created', activityId: 'a1' });
    await expect(
      handleProjectActivityJob(PROJECT_ACTIVITY_RECORD_JOB, job('project.activity.recorded', activityPayload), {
        tenant,
        writer,
      }),
    ).resolves.toEqual({ kind: 'created', activityId: 'a1' });
    expect(calls).toEqual([{ context: SYSTEM(ORG), eventId: EVENT }]);
    expect(tenant.get()).toBeUndefined();
  });

  it.each([
    ['unknown job name', 'other.job', job('project.activity.recorded', activityPayload)],
    ['other event type', PROJECT_ACTIVITY_RECORD_JOB, job('notification.requested', activityPayload)],
    [
      'non-uuid organization',
      PROJECT_ACTIVITY_RECORD_JOB,
      job('project.activity.recorded', activityPayload, { organizationId: 'org' }),
    ],
    [
      'malformed type',
      PROJECT_ACTIVITY_RECORD_JOB,
      job('project.activity.recorded', { ...activityPayload, type: 'DROP TABLE' }),
    ],
    [
      'organization smuggled into the payload',
      PROJECT_ACTIVITY_RECORD_JOB,
      job('project.activity.recorded', { ...activityPayload, organizationId: OTHER_ORG }),
    ],
    [
      'nested summary parameters',
      PROJECT_ACTIVITY_RECORD_JOB,
      job('project.activity.recorded', { ...activityPayload, summaryParams: { x: { y: 1 } } }),
    ],
  ])('fails permanently on %s without writing', async (_label, name, data) => {
    const tenant = new AsyncLocalTenantContext();
    const { writer, calls } = recordingWriter(tenant, { kind: 'duplicate' });
    await expect(handleProjectActivityJob(name, data, { tenant, writer })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(calls).toEqual([]);
  });

  it('fails permanently when the project is not in the event organization', async () => {
    const tenant = new AsyncLocalTenantContext();
    const { writer } = recordingWriter(tenant, { kind: 'project_not_found' });
    await expect(
      handleProjectActivityJob(PROJECT_ACTIVITY_RECORD_JOB, job('project.activity.recorded', activityPayload), {
        tenant,
        writer,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("retires the event organization's cached project dashboards once the entry is recorded", async () => {
    const tenant = new AsyncLocalTenantContext();
    const { writer } = recordingWriter(tenant, { kind: 'created', activityId: 'a1' });
    const invalidated: { organizationId: string; domains: readonly string[] }[] = [];
    const invalidate = (organizationId: string, domains: readonly string[]) => {
      invalidated.push({ organizationId, domains });
      return Promise.resolve();
    };
    await handleProjectActivityJob(PROJECT_ACTIVITY_RECORD_JOB, job('project.activity.recorded', activityPayload), {
      tenant,
      writer,
      invalidate,
    });
    expect(invalidated).toEqual([{ organizationId: ORG, domains: ['projects'] }]);
    const missing = recordingWriter(tenant, { kind: 'project_not_found' });
    await expect(
      handleProjectActivityJob(PROJECT_ACTIVITY_RECORD_JOB, job('project.activity.recorded', activityPayload), {
        tenant,
        writer: missing.writer,
        invalidate,
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(invalidated).toHaveLength(1);
  });

  it('treats a re-delivered event as a duplicate, not a failure', async () => {
    const tenant = new AsyncLocalTenantContext();
    const { writer } = recordingWriter(tenant, { kind: 'duplicate' });
    await expect(
      handleProjectActivityJob(PROJECT_ACTIVITY_RECORD_JOB, job('project.activity.recorded', activityPayload), {
        tenant,
        writer,
      }),
    ).resolves.toEqual({ kind: 'duplicate' });
  });
});

describe('handleDeleteAttachmentObjectJob', () => {
  const attachmentId = '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60';

  function recordingAttachments(tenant: AsyncLocalTenantContext, outcome: boolean | Error) {
    const calls: { context: unknown; attachmentId: string }[] = [];
    const attachments = {
      deleteStoredObject: (id: string) => {
        calls.push({ context: tenant.get(), attachmentId: id });
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    } as unknown as AttachmentService;
    return { attachments, calls };
  }

  it('removes the object in a system context of the event organization', async () => {
    const tenant = new AsyncLocalTenantContext();
    const { attachments, calls } = recordingAttachments(tenant, true);
    await expect(
      handleDeleteAttachmentObjectJob(job('attachment.object.delete', { attachmentId }), { tenant, attachments }),
    ).resolves.toEqual({ deleted: true });
    expect(calls).toEqual([{ context: SYSTEM(ORG), attachmentId }]);
    expect(DELETE_ATTACHMENT_OBJECT_JOB).toBe('attachment-object.delete');
  });

  it('lets storage failures propagate as retryable errors', async () => {
    const tenant = new AsyncLocalTenantContext();
    const { attachments } = recordingAttachments(tenant, new Error('storage unavailable'));
    const failure = handleDeleteAttachmentObjectJob(job('attachment.object.delete', { attachmentId }), {
      tenant,
      attachments,
    });
    await expect(failure).rejects.toThrow('storage unavailable');
    await expect(failure).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    ['other event type', job('notification.requested', { attachmentId })],
    ['non-uuid attachment', job('attachment.object.delete', { attachmentId: '../key' })],
    ['storage key in the payload', job('attachment.object.delete', { attachmentId, storageKey: 'x' })],
  ])('fails permanently on %s without touching storage', async (_label, data) => {
    const tenant = new AsyncLocalTenantContext();
    const { attachments, calls } = recordingAttachments(tenant, true);
    await expect(handleDeleteAttachmentObjectJob(data, { tenant, attachments })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(calls).toEqual([]);
  });
});

describe('checkMissingReports', () => {
  it('checks each organization in its own system context and sums the results', async () => {
    const tenant = new AsyncLocalTenantContext();
    const prisma = {
      $queryRaw: () => Promise.resolve([{ organization_id: ORG }, { organization_id: OTHER_ORG }]),
    } as unknown as PrismaClient;
    const contexts: unknown[] = [];
    const now = new Date('2026-10-02T16:00:00.000Z');
    const check = {
      run: (at: Date) => {
        expect(at).toBe(now);
        contexts.push(tenant.get());
        return Promise.resolve({ projects: 2, notifications: 3 });
      },
    } as unknown as DailyReportMissingCheck;
    await expect(checkMissingReports({ prisma, tenant, check }, now)).resolves.toEqual({
      organizations: 2,
      projects: 4,
      notifications: 6,
    });
    expect(contexts).toEqual([SYSTEM(ORG), SYSTEM(OTHER_ORG)]);
  });
});
