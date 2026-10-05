import type { EnvelopeCipher } from '../../platform/crypto/envelope-cipher.js';
import { enqueueOutboxEvent } from '../../platform/outbox/outbox.js';
import type { TenantDb } from '../../platform/tenancy/tenant-guard.js';
import type { JiraCoordination } from './jira-coordination.js';
import { LockBusyError, refreshLockKey } from './jira-coordination.js';
import { JiraApiError } from './jira-errors.js';
import type { JiraOAuthClient } from './jira-oauth.js';
import type { TokenResponse } from './jira-wire.js';

export type TokenField = 'access_token' | 'refresh_token';

/** AAD binding a token envelope to its organization, connection and field (SECURITY §7). */
export function tokenAad(organizationId: string, connectionId: string, field: TokenField): string {
  return `${organizationId}|${connectionId}|${field}`;
}

/** Refresh this long before expiry so a token never expires mid-request. */
export const REFRESH_MARGIN_MS = 60_000;

export interface EncryptedTokens {
  readonly accessTokenEnc: string;
  readonly refreshTokenEnc: string;
  readonly tokenExpiresAt: Date;
  readonly encryptionKeyId: string;
}

export function encryptTokens(
  cipher: EnvelopeCipher,
  organizationId: string,
  connectionId: string,
  tokens: { accessToken: string; refreshToken: string; expiresInSeconds: number },
  now: Date,
): EncryptedTokens {
  return {
    accessTokenEnc: cipher.encrypt(tokens.accessToken, tokenAad(organizationId, connectionId, 'access_token')),
    refreshTokenEnc: cipher.encrypt(tokens.refreshToken, tokenAad(organizationId, connectionId, 'refresh_token')),
    tokenExpiresAt: new Date(now.getTime() + tokens.expiresInSeconds * 1000),
    encryptionKeyId: cipher.currentKeyId,
  };
}

const connectionTokenSelect = {
  id: true,
  status: true,
  accessTokenEnc: true,
  refreshTokenEnc: true,
  tokenExpiresAt: true,
  version: true,
} as const;

/** Members holding `integration.manage` at ORG scope (re-auth and webhook-failure notifications). */
export async function integrationAdminMemberIds(db: TenantDb, organizationId: string): Promise<string[]> {
  const rows = await db.organizationMember.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      userId: { not: null },
      roles: { some: { role: { permissions: { some: { permissionKey: 'integration.manage', scope: 'ORG' } } } } },
    },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 50,
  });
  return rows.map((row) => row.id);
}

/**
 * Moves a connection to NEEDS_REAUTH (once) and tells the integration administrators. Called when
 * Atlassian rejects the refresh token or keeps rejecting fresh access tokens. No retry loop follows:
 * every caller sees `reauth_required` until an administrator reconnects.
 */
export async function markNeedsReauth(
  db: TenantDb,
  organizationId: string,
  connectionId: string,
  errorCode: string,
): Promise<void> {
  const changed = await db.jiraConnection.updateMany({
    where: { organizationId, id: connectionId, status: { in: ['ACTIVE', 'ERROR'] } },
    data: { status: 'NEEDS_REAUTH', lastErrorCode: errorCode, lastErrorAt: new Date(), version: { increment: 1 } },
  });
  if (changed.count === 0) {
    return;
  }
  const row = await db.jiraConnection.findFirst({
    where: { organizationId, id: connectionId },
    select: { version: true, siteName: true },
  });
  for (const memberId of await integrationAdminMemberIds(db, organizationId)) {
    await enqueueOutboxEvent(db, organizationId, {
      eventType: 'notification.requested',
      aggregateType: 'jira_connection',
      aggregateId: connectionId,
      payload: {
        recipientMemberId: memberId,
        type: 'JIRA_REAUTH_REQUIRED',
        severity: 'WARNING',
        entityType: 'jira_connection',
        entityId: connectionId,
        params: { site: row?.siteName ?? '' },
        dedupeKey: `jira_reauth_required:${connectionId}:${String(row?.version ?? 0)}`,
        email: true,
      },
    });
  }
}

/**
 * Access tokens for a connection. Tokens are decrypted only in memory, right before use, and are
 * never returned to callers outside the adapter. Refresh happens under a per-connection lock: the
 * row is re-read after acquiring it (another process may already have rotated the tokens), and the
 * rotated access and refresh tokens are written together in one versioned update, so a crash can
 * never leave a used refresh token as the only stored one. Envelopes under a retired key are
 * re-encrypted with the current key on refresh.
 */
export class JiraTokenService {
  constructor(
    private readonly db: TenantDb,
    private readonly cipher: EnvelopeCipher,
    private readonly oauth: JiraOAuthClient,
    private readonly coordination: JiraCoordination,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * A valid access token; `force` refreshes even if the stored one has not expired (after a 401).
   * `allowDisconnected` is only for the cleanup job that removes a disconnected connection's webhooks.
   */
  async accessToken(
    organizationId: string,
    connectionId: string,
    force = false,
    allowDisconnected = false,
  ): Promise<string> {
    const row = await this.load(organizationId, connectionId, allowDisconnected);
    if (!force && this.fresh(row.tokenExpiresAt) && !this.cipher.needsRotation(row.accessTokenEnc)) {
      return this.decrypt(organizationId, connectionId, 'access_token', row.accessTokenEnc);
    }
    try {
      return await this.coordination.withLock(
        refreshLockKey(connectionId),
        { ttlMs: 30_000, waitMs: 10_000 },
        async () => {
          const current = await this.load(organizationId, connectionId, allowDisconnected);
          const rotatedByOther = current.version !== row.version;
          if (
            this.fresh(current.tokenExpiresAt) &&
            (rotatedByOther || !force) &&
            !this.cipher.needsRotation(current.accessTokenEnc)
          ) {
            return this.decrypt(organizationId, connectionId, 'access_token', current.accessTokenEnc);
          }
          return this.refresh(organizationId, connectionId, current, allowDisconnected);
        },
      );
    } catch (error) {
      if (error instanceof LockBusyError) {
        throw new JiraApiError('unavailable', null, 'Token refresh is in progress elsewhere.');
      }
      throw error;
    }
  }

  private fresh(expiresAt: Date): boolean {
    return expiresAt.getTime() - REFRESH_MARGIN_MS > this.now().getTime();
  }

  private async refresh(
    organizationId: string,
    connectionId: string,
    row: { accessTokenEnc: string; refreshTokenEnc: string; version: number },
    allowDisconnected: boolean,
  ): Promise<string> {
    const refreshToken = this.decrypt(organizationId, connectionId, 'refresh_token', row.refreshTokenEnc);
    let response: TokenResponse;
    try {
      response = await this.oauth.refresh(refreshToken);
    } catch (error) {
      if (error instanceof JiraApiError && error.kind === 'reauth_required' && !allowDisconnected) {
        await markNeedsReauth(this.db, organizationId, connectionId, error.code);
      }
      throw error;
    }
    const writable: ('ACTIVE' | 'ERROR' | 'DISCONNECTED')[] = allowDisconnected
      ? ['ACTIVE', 'ERROR', 'DISCONNECTED']
      : ['ACTIVE', 'ERROR'];
    const tokens = encryptTokens(
      this.cipher,
      organizationId,
      connectionId,
      {
        accessToken: response.access_token,
        refreshToken: response.refresh_token ?? refreshToken,
        expiresInSeconds: response.expires_in,
      },
      this.now(),
    );
    const updated = await this.db.jiraConnection.updateMany({
      where: { organizationId, id: connectionId, version: row.version, status: { in: writable } },
      data: { ...tokens, version: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new JiraApiError('unavailable', null, 'The Jira connection changed during token refresh.');
    }
    return response.access_token;
  }

  private async load(organizationId: string, connectionId: string, allowDisconnected: boolean) {
    const row = await this.db.jiraConnection.findFirst({
      where: { organizationId, id: connectionId },
      select: connectionTokenSelect,
    });
    if (row === null || (row.status === 'DISCONNECTED' && !allowDisconnected)) {
      throw new JiraApiError('reauth_required', null, 'The Jira connection is disconnected.');
    }
    if (
      row.status === 'NEEDS_REAUTH' ||
      row.accessTokenEnc === null ||
      row.refreshTokenEnc === null ||
      row.tokenExpiresAt === null
    ) {
      throw new JiraApiError('reauth_required', null, 'The Jira connection needs re-authorization.');
    }
    return {
      accessTokenEnc: row.accessTokenEnc,
      refreshTokenEnc: row.refreshTokenEnc,
      tokenExpiresAt: row.tokenExpiresAt,
      version: row.version,
    };
  }

  private decrypt(organizationId: string, connectionId: string, field: TokenField, envelope: string): string {
    try {
      return this.cipher.decrypt(envelope, tokenAad(organizationId, connectionId, field));
    } catch {
      throw new JiraApiError('reauth_required', null, 'Stored Jira credentials cannot be decrypted.');
    }
  }
}
