import { departmentReachIds, teamReachMemberIds } from '../../platform/db/sql/org-hierarchy.js';
import { projectReachIds } from '../../platform/db/sql/project-reach.js';
import type { RawSqlClient } from '../../platform/db/sql/raw-sql-client.js';
import type { EffectivePermissions } from './effective-permissions.js';
import { EMPTY_REACH, needsReach } from './policy.js';
import type { Principal, ScopeReach } from './policy.js';

export interface PrincipalBase {
  readonly userId: string;
  readonly memberId: string;
  readonly organizationId: string;
  readonly permissions: EffectivePermissions;
}

/**
 * Resolves the TEAM, DEPARTMENT and PROJECT reach of a member from the organization's reporting
 * lines, teams, department tree and project staffing (tagged SQL bound to the organization). Called
 * per request, so a hierarchy or membership change takes effect on the member's next request.
 * Members whose grants are all ORG or SELF skip the queries. Reach only widens a grant held at the
 * matching scope, so resolving all three sets never grants anything by itself.
 */
export class ScopeReachResolver {
  constructor(private readonly db: RawSqlClient) {}

  async resolve(base: PrincipalBase): Promise<ScopeReach> {
    if (!needsReach(base.permissions)) {
      return EMPTY_REACH;
    }
    // Sequential: the client may be an interactive transaction, which runs one query at a time.
    const teamMemberIds = await teamReachMemberIds(this.db, base.organizationId, base.memberId);
    const departmentIds = await departmentReachIds(this.db, base.organizationId, base.memberId);
    const projectIds = await projectReachIds(this.db, base.organizationId, base.memberId);
    return {
      teamMemberIds: new Set(teamMemberIds),
      departmentIds: new Set(departmentIds),
      projectIds: new Set(projectIds),
    };
  }

  async principal(base: PrincipalBase): Promise<Principal> {
    return { ...base, reach: await this.resolve(base) };
  }
}
