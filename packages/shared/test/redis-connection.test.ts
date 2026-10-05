import { describe, expect, it } from 'vitest';

import { redisConnectionOptions } from '../src/redis-connection.js';

describe('redisConnectionOptions', () => {
  it('parses host, port and password', () => {
    expect(redisConnectionOptions('redis://:s%40cret@localhost:6380')).toEqual({
      host: 'localhost',
      port: 6380,
      password: 's@cret',
    });
  });

  it('defaults the port and reads username and database index', () => {
    expect(redisConnectionOptions('redis://ops:pw@redis/2')).toEqual({
      host: 'redis',
      port: 6379,
      username: 'ops',
      password: 'pw',
      db: 2,
    });
  });

  it('enables TLS for rediss URLs', () => {
    expect(redisConnectionOptions('rediss://cache.internal:6379').tls).toEqual({});
  });
});
