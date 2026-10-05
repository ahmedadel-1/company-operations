import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Fixed-window counter: INCR, set the window TTL on the first hit, and once the limit is exceeded
 * keep the key blocked for `blockDuration`. One atomic script per request.
 */
const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
if hits == limit + 1 and block > tonumber(ARGV[1]) then
  redis.call('PEXPIRE', KEYS[1], block)
end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

/** Shared across API instances so limits hold behind a load balancer (SECURITY §4). */
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const result: unknown = await this.redis.eval(
      INCREMENT_SCRIPT,
      1,
      `ops:rl:${throttlerName}:${key}`,
      String(ttl),
      String(limit),
      String(blockDuration),
    );
    const values: readonly unknown[] = Array.isArray(result) ? (result as unknown[]) : [];
    const [hits, pttl] = values;
    const totalHits = typeof hits === 'number' ? hits : Number.MAX_SAFE_INTEGER;
    const remainingMs = typeof pttl === 'number' && pttl > 0 ? pttl : ttl;
    const seconds = Math.ceil(remainingMs / 1000);
    const isBlocked = totalHits > limit;
    return { totalHits, timeToExpire: seconds, isBlocked, timeToBlockExpire: isBlocked ? seconds : 0 };
  }
}
