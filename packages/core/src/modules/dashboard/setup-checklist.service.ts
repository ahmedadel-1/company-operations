import { ForbiddenError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { holdsOrgWide } from '../projects/project-access.js';
import { deriveChecklist } from './engine/checklist.js';
import type { SetupItemKey } from './engine/checklist.js';
import { dashboardLink } from './links.js';
import type { DashboardLink } from './links.js';

export interface SetupChecklist {
  readonly items: readonly {
    readonly key: SetupItemKey;
    readonly done: boolean;
    readonly optional: boolean;
    readonly count: number;
    readonly link: DashboardLink;
  }[];
  readonly completed: number;
  readonly required: number;
}

/**
 * First-run checklist for organization administrators (P8-7, ADR-0023): derived from the current rows
 * on every request (nothing stored), so it can never disagree with the screens it links to.
 */
export class SetupChecklistService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
  ) {}

  async get(action: ActionContext): Promise<SetupChecklist> {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'org.settings.manage')) {
      throw new ForbiddenError();
    }
    const departments = await this.db.department.count({ where: { organizationId, archivedAt: null } });
    const otherMembers = await this.db.organizationMember.count({
      where: { organizationId, id: { not: action.principal.memberId }, status: { in: ['INVITED', 'ACTIVE'] } },
    });
    const activeWorkLocations = await this.db.workLocation.count({ where: { organizationId, active: true } });
    const attendancePolicy = (await this.db.attendancePolicy.count({ where: { organizationId } })) > 0;
    const publishedRequestTypes = await this.db.requestType.count({ where: { organizationId, active: true } });
    const slaPolicies = await this.db.slaPolicy.count({ where: { organizationId, active: true } });
    const projects = await this.db.project.count({ where: { organizationId, status: { not: 'ARCHIVED' } } });
    const jiraConnected =
      (await this.db.jiraConnection.count({ where: { organizationId, status: { not: 'DISCONNECTED' } } })) > 0;
    const githubConnected =
      (await this.db.githubInstallation.count({ where: { organizationId, status: { not: 'DISCONNECTED' } } })) > 0;
    const checklist = deriveChecklist({
      departments,
      otherMembers,
      activeWorkLocations,
      attendancePolicy,
      publishedRequestTypes,
      slaPolicies,
      projects,
      jiraConnected,
      githubConnected,
    });
    return {
      items: checklist.items.map((item) => ({
        key: item.key,
        done: item.done,
        optional: item.optional,
        count: item.count,
        link: dashboardLink(item.path),
      })),
      completed: checklist.completed,
      required: checklist.required,
    };
  }
}
