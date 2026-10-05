import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import { githubInstallationOwner } from '../../platform/db/sql/github-scan.js';
import { ForbiddenError } from '../../platform/errors.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { holdsOrgWide } from '../projects/project-access.js';
import { setupStateKey } from './github-coordination.js';
import {
  GithubApiError,
  GithubInstallationConflictError,
  GithubNotConfiguredError,
  GithubSetupInvalidError,
  toGithubDomainError,
} from './github-errors.js';
import { installationFacts } from './github-installations.js';
import { enqueueInstallationSync } from './github-runs.js';
import { githubCallbackUrl } from './github-runtime.js';
import type { GithubRuntime } from './github-runtime.js';
import type { InstallationWire } from './github-wire.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const INSTALLATION_ID = /^[1-9][0-9]{0,18}$/;

/** Binds a setup state to the browser session that started it (hash of the session id). */
interface SetupState {
  readonly organizationId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly session: string;
  /** Set once GitHub returned to the setup URL; then the user authorization proves access. */
  readonly installationId: string | null;
}

function parseState(raw: string): SetupState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'organizationId' in value &&
      'memberId' in value &&
      'userId' in value &&
      'session' in value &&
      'installationId' in value &&
      typeof value.organizationId === 'string' &&
      typeof value.memberId === 'string' &&
      typeof value.userId === 'string' &&
      typeof value.session === 'string' &&
      (value.installationId === null || typeof value.installationId === 'string')
    ) {
      return {
        organizationId: value.organizationId,
        memberId: value.memberId,
        userId: value.userId,
        session: value.session,
        installationId: value.installationId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export type GithubSetupStep =
  /** Continue with GitHub user authorization (proves the user can access the installation). */
  | { readonly kind: 'authorize'; readonly url: string }
  /** GitHub sent an owner approval request instead of an installation; nothing to bind yet. */
  | { readonly kind: 'requested' }
  /** The installation is already bound to this organization (settings changed on GitHub). */
  | { readonly kind: 'refreshed'; readonly installationId: string };

/**
 * GitHub App installation setup (INTEGRATIONS §GitHub, ADR-0020). `integration.manage` at organization
 * scope; the controller additionally requires a fresh MFA session.
 *
 * 1. `startInstall` creates a single-use, 10-minute state bound to organization, member, user and
 *    session, and returns GitHub's installation URL for this App.
 * 2. GitHub returns to the setup URL with `installation_id` — which anyone can forge — and the state.
 *    The state is consumed and re-issued with the installation id, and the browser is sent through
 *    GitHub user authorization.
 * 3. The callback exchanges the code for a short-lived user token, checks that the installation is
 *    among `GET /user/installations` for that GitHub user, revokes the token, re-reads the
 *    installation with the App JWT, and binds it to exactly one organization (audited). An
 *    installation already bound to another organization is refused.
 *
 * A bare `installation_id` therefore never binds anything: the binding needs this deployment's
 * state (session-bound) and proof from GitHub that the signed-in GitHub user can see the installation.
 */
export class GithubSetupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: GithubRuntime | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startInstall(action: ActionContext, session: string): Promise<{ installUrl: string }> {
    const organizationId = this.authorize(action);
    const runtime = this.requireRuntime();
    if (runtime.settings.slug === null) {
      throw new GithubNotConfiguredError();
    }
    const state = await this.issueState(runtime, action, organizationId, session, null);
    await recordAudit(this.db, organizationId, {
      action: 'github.installation.install_started',
      entityType: 'github_installation',
      entityId: null,
      actor: userActor(action),
      context: action.request,
    });
    const url = `${runtime.settings.webBaseUrl}/apps/${encodeURIComponent(runtime.settings.slug)}/installations/new`;
    return { installUrl: `${url}?${new URLSearchParams({ state }).toString()}` };
  }

  async handleSetup(
    action: ActionContext,
    session: string,
    input: { installationId: string | null; setupAction: string | null; state: string | null },
  ): Promise<GithubSetupStep> {
    const organizationId = this.authorize(action);
    const runtime = this.requireRuntime();
    if (input.setupAction === 'request') {
      return { kind: 'requested' };
    }
    const githubId = input.installationId;
    if (githubId === null || !INSTALLATION_ID.test(githubId)) {
      throw new GithubSetupInvalidError();
    }
    const state = input.state === null ? null : await this.takeState(runtime, input.state);
    if (state === null || !this.matches(state, action, organizationId, session) || state.installationId !== null) {
      const bound = await this.db.githubInstallation.findFirst({
        where: { organizationId, githubInstallationId: BigInt(githubId), status: { in: ['ACTIVE', 'SUSPENDED'] } },
        select: { id: true },
      });
      if (bound === null) {
        throw new GithubSetupInvalidError();
      }
      await enqueueInstallationSync(this.db, organizationId, bound.id);
      return { kind: 'refreshed', installationId: bound.id };
    }
    const next = await this.issueState(runtime, action, organizationId, session, githubId);
    return { kind: 'authorize', url: runtime.users.authorizeUrl(next, githubCallbackUrl(runtime.settings)) };
  }

  async completeCallback(
    action: ActionContext,
    session: string,
    input: { code: string; state: string },
  ): Promise<{ installationId: string }> {
    const organizationId = this.authorize(action);
    const runtime = this.requireRuntime();
    const state = await this.takeState(runtime, input.state);
    if (state === null || !this.matches(state, action, organizationId, session) || state.installationId === null) {
      throw new GithubSetupInvalidError();
    }
    const githubId = state.installationId;
    let wire: InstallationWire;
    try {
      const userToken = await runtime.users.exchangeCode(input.code, githubCallbackUrl(runtime.settings));
      let accessible: Set<string>;
      try {
        accessible = await runtime.users.installationIds(userToken);
      } finally {
        await runtime.users.revoke(userToken).catch((): void => undefined);
      }
      if (!accessible.has(githubId)) {
        throw new GithubSetupInvalidError('Your GitHub account cannot access this installation.');
      }
      wire = await runtime.app.getInstallation(githubId);
    } catch (error) {
      throw error instanceof GithubApiError ? toGithubDomainError(error, 'GitHub installation') : error;
    }
    const owner = await githubInstallationOwner(this.prisma, githubId);
    if (owner !== null && owner !== organizationId) {
      throw new GithubInstallationConflictError();
    }
    try {
      const installationId = await this.bind(action, organizationId, githubId, wire);
      return { installationId };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GithubInstallationConflictError();
      }
      throw error;
    }
  }

  private async bind(
    action: ActionContext,
    organizationId: string,
    githubId: string,
    wire: InstallationWire,
  ): Promise<string> {
    const facts = installationFacts(wire);
    const suspendedAt =
      wire.suspended_at === null || wire.suspended_at === undefined ? null : new Date(wire.suspended_at);
    const lifecycle = {
      status: suspendedAt === null ? ('ACTIVE' as const) : ('SUSPENDED' as const),
      suspendedAt,
      deletedAt: null,
      disconnectedAt: null,
      lastErrorCode: null,
      lastErrorAt: null,
    };
    return this.db.$transaction(async (tx) => {
      const existing = await tx.githubInstallation.findFirst({
        where: { organizationId, githubInstallationId: BigInt(githubId) },
        select: { id: true, status: true },
      });
      let id: string;
      if (existing === null) {
        const created = await tx.githubInstallation.create({
          data: {
            organizationId,
            githubInstallationId: BigInt(githubId),
            ...facts,
            ...lifecycle,
            installedByMemberId: action.principal.memberId,
            boundAt: this.now(),
          },
          select: { id: true },
        });
        id = created.id;
      } else {
        await tx.githubInstallation.updateMany({
          where: { organizationId, id: existing.id },
          data: {
            ...facts,
            ...lifecycle,
            ...(existing.status === 'DELETED' || existing.status === 'DISCONNECTED'
              ? { installedByMemberId: action.principal.memberId, boundAt: this.now() }
              : {}),
            version: { increment: 1 },
          },
        });
        id = existing.id;
      }
      await recordAudit(tx, organizationId, {
        action: existing === null ? 'github.installation.bound' : 'github.installation.rebound',
        entityType: 'github_installation',
        entityId: id,
        actor: userActor(action),
        metadata: {
          githubInstallationId: githubId,
          account: facts.accountLogin,
          accountType: facts.accountType,
          repositorySelection: facts.repositorySelection,
        },
        context: action.request,
      });
      await enqueueInstallationSync(tx, organizationId, id);
      return id;
    });
  }

  private async issueState(
    runtime: GithubRuntime,
    action: ActionContext,
    organizationId: string,
    session: string,
    installationId: string | null,
  ): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const payload: SetupState = {
      organizationId,
      memberId: action.principal.memberId,
      userId: action.principal.userId,
      session,
      installationId,
    };
    await runtime.kv.set(setupStateKey(state), JSON.stringify(payload), STATE_TTL_MS);
    return state;
  }

  private async takeState(runtime: GithubRuntime, state: string): Promise<SetupState | null> {
    if (state.length === 0 || state.length > 200) {
      return null;
    }
    const raw = await runtime.kv.take(setupStateKey(state));
    return raw === null ? null : parseState(raw);
  }

  private matches(state: SetupState, action: ActionContext, organizationId: string, session: string): boolean {
    return (
      state.organizationId === organizationId &&
      state.memberId === action.principal.memberId &&
      state.userId === action.principal.userId &&
      state.session === session
    );
  }

  private authorize(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'integration.manage')) {
      throw new ForbiddenError();
    }
    return organizationId;
  }

  private requireRuntime(): GithubRuntime {
    if (this.runtime === null) {
      throw new GithubNotConfiguredError();
    }
    return this.runtime;
  }
}
