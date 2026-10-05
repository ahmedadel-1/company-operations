import type { PermissionKey } from '@company-ops/shared';

/**
 * Real-time fan-out (ARCHITECTURE §5, P3-10). Events are hints that something changed: they carry a
 * type and an entity id only, never content, and clients re-fetch through the authorized API.
 * Channel names always embed the organization id, and an SSE connection subscribes only to channels
 * of its session's active organization, so another tenant's events cannot reach it.
 */
export interface RealtimeEvent {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
}

export interface RealtimePublisher {
  publish(channel: string, event: RealtimeEvent): Promise<void>;
}

/** Discards events (tests, processes without Redis). */
export const NO_REALTIME: RealtimePublisher = { publish: () => Promise.resolve() };

/** Events for one user in one organization. */
export function userChannel(organizationId: string, userId: string): string {
  return `rt:org:${organizationId}:user:${userId}`;
}

/** Events for everyone holding `permission` at ORG scope in one organization. */
export function permissionChannel(organizationId: string, permission: PermissionKey): string {
  return `rt:org:${organizationId}:perm:${permission}`;
}

/** Publishes without letting a real-time failure fail the business operation that already committed. */
export async function publishQuietly(
  publisher: RealtimePublisher,
  channels: readonly string[],
  event: RealtimeEvent,
  onError: (error: unknown) => void,
): Promise<void> {
  await Promise.all(
    [...new Set(channels)].map(async (channel) => {
      try {
        await publisher.publish(channel, event);
      } catch (error) {
        onError(error);
      }
    }),
  );
}
