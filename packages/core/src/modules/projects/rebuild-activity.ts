import type { PrismaClient } from '@company-ops/db';

import { AsyncLocalTenantContext } from '../../platform/tenancy/tenant-context.js';
import { createTenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { ProjectActivityWriter } from './project-activity.js';

export type RebuildActivityOutcome =
  | { readonly kind: 'organization_not_found' }
  | { readonly kind: 'project_not_found' }
  | { readonly kind: 'rebuilt'; readonly deleted: number; readonly created: number };

/**
 * Operator recovery (`pnpm activity:rebuild`): re-derives the project timeline of one organization,
 * optionally limited to one project by code, from the retained outbox events. Runs in a system
 * tenant context of that organization only.
 */
export async function rebuildProjectActivity(
  prisma: PrismaClient,
  input: { readonly organizationSlug: string; readonly projectCode?: string | undefined },
): Promise<RebuildActivityOutcome> {
  const organization = await prisma.organization.findUnique({
    where: { slug: input.organizationSlug },
    select: { id: true },
  });
  if (organization === null) {
    return { kind: 'organization_not_found' };
  }
  const organizationId = organization.id;
  const tenant = new AsyncLocalTenantContext();
  const db = createTenantScopedClient(prisma, tenant);
  const writer = new ProjectActivityWriter(db, tenant);
  return tenant.run({ organizationId, memberId: null, userId: null }, async () => {
    let projectId: string | undefined;
    if (input.projectCode !== undefined) {
      const project = await db.project.findFirst({
        where: { organizationId, code: input.projectCode },
        select: { id: true },
      });
      if (project === null) {
        return { kind: 'project_not_found' } as const;
      }
      projectId = project.id;
    }
    return { kind: 'rebuilt', ...(await writer.rebuild(projectId)) } as const;
  });
}
