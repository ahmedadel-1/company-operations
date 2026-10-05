import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import { MAX_STREAMS_PER_USER, RealtimeHub } from '../src/realtime/realtime-hub.js';

/** Stream slots and graceful shutdown; no Redis connection is opened by these paths. */
function hub(): RealtimeHub {
  return new RealtimeHub({} as Redis);
}

describe('RealtimeHub', () => {
  it('limits open streams per user and frees slots on release', () => {
    const realtime = hub();
    for (let index = 0; index < MAX_STREAMS_PER_USER; index += 1) {
      expect(realtime.acquire('user-1')).toBe(true);
    }
    expect(realtime.hasCapacity('user-1')).toBe(false);
    expect(realtime.acquire('user-1')).toBe(false);
    expect(realtime.acquire('user-2')).toBe(true);
    realtime.release('user-1');
    expect(realtime.acquire('user-1')).toBe(true);
  });

  it('ends every registered stream on shutdown and refuses new ones while draining', () => {
    const realtime = hub();
    const closed: string[] = [];
    realtime.onShutdown(() => closed.push('a'));
    const unregister = realtime.onShutdown(() => closed.push('b'));
    realtime.onShutdown(() => closed.push('c'));
    unregister();
    expect(realtime.acquire('user-1')).toBe(true);

    realtime.beforeApplicationShutdown();

    expect(closed).toEqual(['a', 'c']);
    expect(realtime.hasCapacity('user-1')).toBe(false);
    expect(realtime.acquire('user-2')).toBe(false);
    realtime.beforeApplicationShutdown();
    expect(closed).toEqual(['a', 'c']);
  });
});
