import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { JiraConnectionStatus, Prisma } from '@company-ops/db';

import { recordAudit } from '../../platform/audit/audit-writer.js';
import type { EnvelopeCipher } from '../../platform/crypto/envelope-cipher.js';
import { isUniqueViolation } from '../../platform/db/prisma-errors.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidInputError,
  NotFoundError,
  VersionConflictError,
} from '../../platform/errors.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { TenantContextAccessor } from '../../platform/tenancy/tenant-context.js';
import type { TenantDb, TenantScopedClient } from '../../platform/tenancy/tenant-guard.js';
import { boundOrganizationId, userActor } from '../action-context.js';
import type { ActionContext } from '../action-context.js';
import { holdsOrgWide } from '../projects/project-access.js';
import { JiraApiError, JiraNotConfiguredError, JiraRequestRejectedError, toJiraDomainError } from './jira-errors.js';
import { jiraRedirectUri, REQUIRED_SITE_SCOPES } from './jira-oauth.js';
import { canRegisterWebhooks, usesTestDouble } from './jira-runtime.js';
import type { JiraRuntime } from './jira-runtime.js';
import { encryptTokens } from './jira-tokens.js';
import type { AccessibleResource, TokenResponse } from './jira-wire.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const GRANT_TTL_MS = 10 * 60 * 1000;

export interface JiraWebhookHealth {
  readonly state: 'ACTIVE' | 'NOT_REGISTERED' | 'ERROR' | 'UNSUPPORTED';
  readonly errorCode: string | null;
  readonly expiresAt: string | null;
}

export interface JiraConnectionView {
  readonly id: string;
  readonly cloudId: string;
  readonly siteName: string;
  readonly siteUrl: string;
  readonly status: JiraConnectionStatus;
  readonly connectedAt: string;
  readonly connectedBy: { readonly memberId: string; readonly fullName: string | null } | null;
  readonly lastSuccessAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorAt: string | null;
  readonly scopes: readonly string[];
  readonly webhook: JiraWebhookHealth;
  readonly version: number;
}

export interface JiraIntegrationStatus {
  readonly configured: boolean;
  /** The redirect URI to register on the Atlassian app (shown to administrators). */
  readonly redirectUri: string | null;
  readonly webhooksSupported: boolean;
  readonly connection: JiraConnectionView | null;
}

export interface JiraSiteOption {
  readonly cloudId: string;
  readonly name: string;
  readonly url: string;
  readonly missingScopes: readonly string[];
}

export type JiraCallbackResult =
  | { readonly kind: 'connected'; readonly connectionId: string }
  | { readonly kind: 'select_site'; readonly grantId: string };

interface OAuthState {
  readonly organizationId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly connectionId: string | null;
}

interface PendingGrant {
  readonly organizationId: string;
  readonly memberId: string;
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
  readonly sites: readonly AccessibleResource[];
}

const connectionSelect = {
  id: true,
  cloudId: true,
  siteName: true,
  siteUrl: true,
  status: true,
  connectedAt: true,
  lastSuccessAt: true,
  lastErrorCode: true,
  lastErrorAt: true,
  webhookErrorCode: true,
  scopes: true,
  version: true,
  connectedBy: { select: { id: true, profile: { select: { fullName: true } } } },
  registrations: { select: { expiresAt: true }, orderBy: { expiresAt: 'asc' }, take: 1 },
} satisfies Prisma.JiraConnectionSelect;

type ConnectionRow = Prisma.JiraConnectionGetPayload<{ select: typeof connectionSelect }>;

const stateKey = (state: string): string => `jira:oauth:state:${createHash('sha256').update(state).digest('hex')}`;
const grantKey = (grantId: string): string => `jira:oauth:grant:${grantId}`;
const grantAad = (organizationId: string, grantId: string): string => `jira-grant|${organizationId}|${grantId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseState(raw: string): OAuthState | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.organizationId === 'string' &&
      typeof value.memberId === 'string' &&
      typeof value.userId === 'string' &&
      (value.connectionId === null || typeof value.connectionId === 'string')
    ) {
      return {
        organizationId: value.organizationId,
        memberId: value.memberId,
        userId: value.userId,
        connectionId: value.connectionId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function parseGrant(raw: string): PendingGrant | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      typeof value.organizationId === 'string' &&
      typeof value.memberId === 'string' &&
      typeof value.userId === 'string' &&
      typeof value.accessToken === 'string' &&
      typeof value.refreshToken === 'string' &&
      typeof value.expiresIn === 'number' &&
      Array.isArray(value.sites)
    ) {
      const sites: AccessibleResource[] = [];
      for (const site of value.sites) {
        if (
          isRecord(site) &&
          typeof site.id === 'string' &&
          typeof site.name === 'string' &&
          typeof site.url === 'string' &&
          Array.isArray(site.scopes)
        ) {
          sites.push({
            id: site.id,
            name: site.name,
            url: site.url,
            scopes: site.scopes.filter((scope): scope is string => typeof scope === 'string'),
          });
        }
      }
      return {
        organizationId: value.organizationId,
        memberId: value.memberId,
        userId: value.userId,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresIn: value.expiresIn,
        sites,
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Jira connection lifecycle (INTEGRATIONS §1.9.2, SECURITY §7): `integration.manage` at
 * organization scope only. OAuth `state` is 32 random bytes, stored hashed for 10 minutes, single
 * use, and bound to the organization, member and user that started the flow. The site (`cloudId`)
 * is only ever taken from Atlassian's accessible-resources response for the exchanged token, never
 * from the browser; with several sites the token waits encrypted (10 minutes, single use) while
 * the administrator picks one. Tokens are stored as envelopes bound to the connection and are never
 * returned by any method here.
 */
export class JiraConnectionService {
  constructor(
    private readonly db: TenantScopedClient,
    private readonly tenant: TenantContextAccessor,
    private readonly runtime: JiraRuntime | null,
    private readonly cipher: EnvelopeCipher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(action: ActionContext): Promise<JiraIntegrationStatus> {
    const organizationId = this.authorize(action);
    const row = await this.db.jiraConnection.findFirst({
      where: { organizationId, status: { not: 'DISCONNECTED' } },
      select: connectionSelect,
    });
    return {
      configured: this.runtime !== null,
      redirectUri: this.runtime === null ? null : jiraRedirectUri(this.runtime.settings),
      webhooksSupported: this.runtime !== null && canRegisterWebhooks(this.runtime.settings),
      connection: row === null ? null : this.view(row),
    };
  }

  /** Starts consent; `connectionId` re-authorizes an existing connection (same site only). */
  async startConnect(action: ActionContext, connectionId: string | null): Promise<{ authorizeUrl: string }> {
    const organizationId = this.authorize(action);
    const runtime = this.requireRuntime();
    if (connectionId !== null) {
      const existing = await this.db.jiraConnection.findFirst({
        where: { organizationId, id: connectionId },
        select: { status: true },
      });
      if (existing === null || existing.status === 'DISCONNECTED') {
        throw new NotFoundError('Jira connection');
      }
    } else {
      const live = await this.db.jiraConnection.findFirst({
        where: { organizationId, status: { not: 'DISCONNECTED' } },
        select: { id: true },
      });
      if (live !== null) {
        throw new ConflictError('Jira is already connected. Re-authorize or disconnect the current site first.');
      }
    }
    const state = randomBytes(32).toString('base64url');
    const payload: OAuthState = {
      organizationId,
      memberId: action.principal.memberId,
      userId: action.principal.userId,
      connectionId,
    };
    await runtime.kv.set(stateKey(state), JSON.stringify(payload), STATE_TTL_MS);
    await recordAudit(this.db, organizationId, {
      action: 'jira.connection.consent_started',
      entityType: 'jira_connection',
      entityId: connectionId,
      actor: userActor(action),
      context: action.request,
    });
    return { authorizeUrl: runtime.oauth.authorizeUrl(state) };
  }

  /** OAuth callback: validates state, exchanges the code, then connects or asks for a site. */
  async completeCallback(action: ActionContext, input: { code: string; state: string }): Promise<JiraCallbackResult> {
    const organizationId = this.authorize(action);
    const runtime = this.requireRuntime();
    const raw = await runtime.kv.take(stateKey(input.state));
    const state = raw === null ? null : parseState(raw);
    if (
      state?.organizationId !== organizationId ||
      state.memberId !== action.principal.memberId ||
      state.userId !== action.principal.userId
    ) {
      throw new ForbiddenError('The Jira authorization could not be verified. Start again.');
    }
    let tokens: TokenResponse;
    let sites: AccessibleResource[];
    try {
      tokens = await runtime.oauth.exchangeCode(input.code);
      sites = await runtime.oauth.accessibleResources(tokens.access_token);
    } catch (error) {
      throw error instanceof JiraApiError ? toJiraDomainError(error) : error;
    }
    if (tokens.refresh_token === undefined) {
      throw new JiraRequestRejectedError('Atlassian did not issue a refresh token (offline access).');
    }
    const usable = sites.filter((site) => this.siteUrlAllowed(site.url));
    if (state.connectionId !== null) {
      const connection = await this.db.jiraConnection.findFirst({
        where: { organizationId, id: state.connectionId },
        select: { cloudId: true },
      });
      const site = usable.find((candidate) => candidate.id === connection?.cloudId);
      if (connection === null || site === undefined) {
        throw new InvalidInputError('cloudId', 'The authorized account has no access to the connected Jira site.');
      }
      const id = await this.store(
        action,
        organizationId,
        site,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
      );
      return { kind: 'connected', connectionId: id };
    }
    if (usable.length === 0) {
      throw new JiraRequestRejectedError('The authorized account has no accessible Jira site.');
    }
    const only = usable[0];
    if (usable.length === 1 && only !== undefined) {
      const id = await this.store(
        action,
        organizationId,
        only,
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
      );
      return { kind: 'connected', connectionId: id };
    }
    const grantId = randomUUID();
    const grant: PendingGrant = {
      organizationId,
      memberId: action.principal.memberId,
      userId: action.principal.userId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      sites: usable,
    };
    await runtime.kv.set(
      grantKey(grantId),
      this.cipher.encrypt(JSON.stringify(grant), grantAad(organizationId, grantId)),
      GRANT_TTL_MS,
    );
    return { kind: 'select_site', grantId };
  }

  /** Sites of a pending grant (names and URLs only). */
  async pendingSites(action: ActionContext, grantId: string): Promise<JiraSiteOption[]> {
    const organizationId = this.authorize(action);
    const grant = await this.readGrant(action, organizationId, grantId, false);
    return grant.sites.map((site) => ({
      cloudId: site.id,
      name: site.name,
      url: site.url,
      missingScopes: REQUIRED_SITE_SCOPES.filter((scope) => !site.scopes.includes(scope)),
    }));
  }

  async selectSite(action: ActionContext, grantId: string, cloudId: string): Promise<JiraConnectionView> {
    const organizationId = this.authorize(action);
    const grant = await this.readGrant(action, organizationId, grantId, true);
    const site = grant.sites.find((candidate) => candidate.id === cloudId);
    if (site === undefined) {
      throw new InvalidInputError('cloudId', 'Choose one of the sites the authorized account can access.');
    }
    const id = await this.store(action, organizationId, site, grant.accessToken, grant.refreshToken, grant.expiresIn);
    return this.get(organizationId, id);
  }

  /**
   * Disconnect: takes effect immediately (no further Jira calls or webhook processing), cancels
   * active runs, and queues removal of the webhooks followed by wiping the stored tokens. Cached
   * issues, mappings and ticket links stay as history; reconnecting the same site resumes them.
   */
  async disconnect(action: ActionContext, connectionId: string, version: number): Promise<JiraConnectionView> {
    const organizationId = this.authorize(action);
    await this.db.$transaction(async (tx) => {
      const row = await tx.jiraConnection.findFirst({
        where: { organizationId, id: connectionId },
        select: { status: true, version: true, siteName: true },
      });
      if (row === null) {
        throw new NotFoundError('Jira connection');
      }
      if (row.status === 'DISCONNECTED') {
        return;
      }
      const updated = await tx.jiraConnection.updateMany({
        where: { organizationId, id: connectionId, version },
        data: { status: 'DISCONNECTED', disconnectedAt: this.now(), version: { increment: 1 } },
      });
      if (updated.count === 0) {
        throw new VersionConflictError('Jira connection');
      }
      await cancelActiveRuns(tx, organizationId, { connectionId }, this.now());
      await enqueueOutboxEvent(tx, organizationId, {
        eventType: 'jira.connection.cleanup',
        aggregateType: 'jira_connection',
        aggregateId: connectionId,
        payload: { connectionId },
      });
      await recordAudit(tx, organizationId, {
        action: 'jira.connection.disconnected',
        entityType: 'jira_connection',
        entityId: connectionId,
        actor: userActor(action),
        metadata: { site: row.siteName },
        context: action.request,
      });
    });
    return this.get(organizationId, connectionId);
  }

  private async readGrant(
    action: ActionContext,
    organizationId: string,
    grantId: string,
    consume: boolean,
  ): Promise<PendingGrant> {
    const runtime = this.requireRuntime();
    const raw = consume ? await runtime.kv.take(grantKey(grantId)) : await runtime.kv.get(grantKey(grantId));
    let grant: PendingGrant | null = null;
    if (raw !== null) {
      try {
        grant = parseGrant(this.cipher.decrypt(raw, grantAad(organizationId, grantId)));
      } catch {
        grant = null;
      }
    }
    if (grant?.memberId !== action.principal.memberId || grant.userId !== action.principal.userId) {
      throw new NotFoundError('Jira authorization');
    }
    return grant;
  }

  /** Creates, reactivates or re-authorizes the connection for `site` with fresh tokens. */
  private async store(
    action: ActionContext,
    organizationId: string,
    site: AccessibleResource,
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
  ): Promise<string> {
    const missing = REQUIRED_SITE_SCOPES.filter((scope) => !site.scopes.includes(scope));
    if (missing.length > 0) {
      throw new JiraRequestRejectedError(
        'The Jira site did not grant the permissions this integration needs.',
        missing,
      );
    }
    const siteUrl = site.url.replace(/\/+$/, '');
    try {
      return await this.db.$transaction(async (tx) => {
        const live = await tx.jiraConnection.findFirst({
          where: { organizationId, status: { not: 'DISCONNECTED' } },
          select: { id: true, cloudId: true },
        });
        if (live !== null && live.cloudId !== site.id) {
          throw new ConflictError('Another Jira site is connected. Disconnect it first.');
        }
        const existing =
          live ??
          (await tx.jiraConnection.findFirst({
            where: { organizationId, cloudId: site.id },
            select: { id: true, cloudId: true },
          }));
        const id = existing?.id ?? randomUUID();
        const tokens = encryptTokens(
          this.cipher,
          organizationId,
          id,
          { accessToken, refreshToken, expiresInSeconds: expiresIn },
          this.now(),
        );
        const fields = {
          siteName: site.name.slice(0, 255),
          siteUrl,
          scopes: site.scopes.slice(0, 50),
          status: 'ACTIVE' as const,
          ...tokens,
          lastErrorCode: null,
          lastErrorAt: null,
          disconnectedAt: null,
        };
        if (existing === null) {
          await tx.jiraConnection.create({
            data: {
              id,
              organizationId,
              cloudId: site.id,
              connectedByMemberId: action.principal.memberId,
              connectedAt: this.now(),
              ...fields,
            },
            select: { id: true },
          });
        } else {
          await tx.jiraConnection.updateMany({
            where: { organizationId, id },
            data: {
              ...fields,
              ...(live === null ? { connectedByMemberId: action.principal.memberId, connectedAt: this.now() } : {}),
              version: { increment: 1 },
            },
          });
        }
        await enqueueOutboxEvent(tx, organizationId, {
          eventType: 'jira.webhooks.sync',
          aggregateType: 'jira_connection',
          aggregateId: id,
          payload: { connectionId: id },
        });
        await recordAudit(tx, organizationId, {
          action: live === null ? 'jira.connection.connected' : 'jira.connection.reauthorized',
          entityType: 'jira_connection',
          entityId: id,
          actor: userActor(action),
          metadata: { site: site.name, cloudId: site.id },
          context: action.request,
        });
        return id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Another Jira connection was created at the same time. Reload and try again.');
      }
      throw error;
    }
  }

  private async get(organizationId: string, connectionId: string): Promise<JiraConnectionView> {
    const row = await this.db.jiraConnection.findFirst({
      where: { organizationId, id: connectionId },
      select: connectionSelect,
    });
    if (row === null) {
      throw new NotFoundError('Jira connection');
    }
    return this.view(row);
  }

  private view(row: ConnectionRow): JiraConnectionView {
    const expiresAt = row.registrations[0]?.expiresAt ?? null;
    let webhook: JiraWebhookHealth;
    if (this.runtime === null || !canRegisterWebhooks(this.runtime.settings)) {
      webhook = { state: 'UNSUPPORTED', errorCode: row.webhookErrorCode, expiresAt: null };
    } else if (row.webhookErrorCode !== null) {
      webhook = { state: 'ERROR', errorCode: row.webhookErrorCode, expiresAt: expiresAt?.toISOString() ?? null };
    } else {
      webhook = {
        state: expiresAt === null ? 'NOT_REGISTERED' : 'ACTIVE',
        errorCode: null,
        expiresAt: expiresAt?.toISOString() ?? null,
      };
    }
    return {
      id: row.id,
      cloudId: row.cloudId,
      siteName: row.siteName,
      siteUrl: row.siteUrl,
      status: row.status,
      connectedAt: row.connectedAt.toISOString(),
      connectedBy:
        row.connectedBy === null
          ? null
          : { memberId: row.connectedBy.id, fullName: row.connectedBy.profile?.fullName ?? null },
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      scopes: row.scopes,
      webhook,
      version: row.version,
    };
  }

  /** Site URLs come from Atlassian; https is required except on the configured test double. */
  private siteUrlAllowed(url: string): boolean {
    return url.startsWith('https://') || (this.runtime !== null && usesTestDouble(this.runtime.settings));
  }

  private authorize(action: ActionContext): string {
    const organizationId = boundOrganizationId(this.tenant, action);
    if (!holdsOrgWide(action.principal, 'integration.manage')) {
      throw new ForbiddenError();
    }
    return organizationId;
  }

  private requireRuntime(): JiraRuntime {
    if (this.runtime === null) {
      throw new JiraNotConfiguredError();
    }
    return this.runtime;
  }
}

/** Cancels queued runs and asks running ones to stop at the next page boundary. */
export async function cancelActiveRuns(
  tx: TenantDb,
  organizationId: string,
  scope: { connectionId: string } | { mappingId: string },
  now: Date,
): Promise<void> {
  await tx.jiraSyncRun.updateMany({
    where: { organizationId, ...scope, status: 'QUEUED' },
    data: { status: 'CANCELLED', cancelRequested: true, finishedAt: now },
  });
  await tx.jiraSyncRun.updateMany({
    where: { organizationId, ...scope, status: 'RUNNING' },
    data: { cancelRequested: true },
  });
}
