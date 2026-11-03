import { Redis } from 'ioredis';
import type { Logger } from './logger.js';

export type { Redis };

interface RedisClientOptions {
  /** Shown in `CLIENT LIST`, which makes connections attributable when debugging. */
  name: string;
  logger: Logger;
  /**
   * BullMQ workers issue blocking commands and require `maxRetriesPerRequest: null`.
   * Request-path clients instead fail fast so an outage degrades the request rather than hanging it.
   */
  blocking?: boolean;
}

export function createRedisClient(
  url: string,
  { name, logger, blocking = false }: RedisClientOptions,
): Redis {
  const client = new Redis(url, {
    connectionName: `vibe:${name}`,
    lazyConnect: true,
    maxRetriesPerRequest: blocking ? null : 2,
    // Reconnect with capped linear backoff, forever: a Redis restart should heal without a process restart.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  // ioredis emits 'error' on every failed reconnect; an unhandled 'error' event would crash the process.
  client.on('error', (err) => logger.error({ err, client: name }, 'Redis error'));
  client.on('ready', () => logger.info({ client: name }, 'Redis ready'));
  client.on('reconnecting', (delayMs: number) =>
    logger.warn({ client: name, delayMs }, 'Redis reconnecting'),
  );

  return client;
}
