import type { z } from 'zod';
import type { Logger } from '../infra/logger.js';
import type { Redis } from '../infra/redis.js';

const TTL_JITTER = 0.1;

/** Spreads expiries so keys written together don't all expire (and reload) together. */
function jitteredTtl(ttlSeconds: number): number {
  return Math.round(ttlSeconds * (1 + Math.random() * TTL_JITTER));
}

interface CacheAsideOptions<S extends z.ZodType> {
  redis: Redis;
  logger: Logger;
  key: string;
  ttlSeconds: number;
  /** Cached values are re-validated on read, so a malformed or stale-shaped entry is a miss, not a crash. */
  schema: S;
  load: () => Promise<z.output<S> | null>;
}

/**
 * Read-through cache. Redis failures degrade to a database read (logged, never thrown):
 * the cache is an optimization, MongoDB is the source of truth.
 * `null` results are not cached, so a record created right after a miss is visible immediately.
 */
export async function cacheAside<S extends z.ZodType>({
  redis,
  logger,
  key,
  ttlSeconds,
  schema,
  load,
}: CacheAsideOptions<S>): Promise<z.output<S> | null> {
  try {
    const cached = await redis.get(key);
    if (cached !== null) {
      const parsed = schema.safeParse(JSON.parse(cached));
      if (parsed.success) return parsed.data;
      logger.warn({ key }, 'Discarding malformed cache entry');
    }
  } catch (err) {
    logger.warn({ err, key }, 'Cache read failed; falling back to database');
  }

  const value = await load();
  if (value !== null) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', jitteredTtl(ttlSeconds));
    } catch (err) {
      logger.warn({ err, key }, 'Cache write failed');
    }
  }
  return value;
}

/**
 * Deletes keys after a write. Runs after the database commit; if it fails, the stale entry
 * lives at most one TTL, which is why TTLs on invalidated keys stay short.
 */
export async function invalidate(redis: Redis, logger: Logger, ...keys: string[]): Promise<void> {
  try {
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err, keys }, 'Cache invalidation failed; entries will expire by TTL');
  }
}
