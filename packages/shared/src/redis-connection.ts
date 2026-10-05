export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  tls?: Record<string, never>;
}

/**
 * Converts `REDIS_URL` into connection options. BullMQ then creates and owns its connections
 * (including the blocking ones workers need) instead of sharing a single client.
 */
export function redisConnectionOptions(redisUrl: string): RedisConnectionOptions {
  const url = new URL(redisUrl);
  const options: RedisConnectionOptions = {
    host: url.hostname,
    port: url.port === '' ? 6379 : Number(url.port),
  };
  if (url.username !== '') {
    options.username = decodeURIComponent(url.username);
  }
  if (url.password !== '') {
    options.password = decodeURIComponent(url.password);
  }
  const db = url.pathname.replace(/^\//, '');
  if (db !== '') {
    options.db = Number(db);
  }
  if (url.protocol === 'rediss:') {
    options.tls = {};
  }
  return options;
}
