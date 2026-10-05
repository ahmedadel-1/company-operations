import type { Redis } from 'ioredis';

import type { RealtimeEvent, RealtimePublisher } from '@company-ops/core';

/** Redis pub/sub adapter of the real-time port; the API's SSE hub subscribes to the same channels. */
export class RedisRealtimePublisher implements RealtimePublisher {
  constructor(private readonly redis: Redis) {}

  async publish(channel: string, event: RealtimeEvent): Promise<void> {
    await this.redis.publish(
      channel,
      JSON.stringify({ type: event.type, entityType: event.entityType, entityId: event.entityId }),
    );
  }
}
