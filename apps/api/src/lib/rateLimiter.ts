import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Redis } from '../infra/redis.js';

/**
 * Sliding-window counter, evaluated atomically in Redis.
 *
 * Keeps one counter per fixed window (a hash with at most two live fields) and estimates the
 * rolling count as `previous * overlap + current`, where overlap is the fraction of the previous
 * window still inside the sliding window. Compared with alternatives:
 * - fixed window: O(1) memory but allows 2x the limit in a burst straddling a boundary;
 * - sliding log (sorted set of timestamps): exact, but O(limit) memory and O(log n) per request;
 * - this: O(1) memory and time, with a small error from assuming uniform traffic in the previous window.
 *
 * Time comes from Redis (`TIME`), not the API process, so instances with skewed clocks agree.
 * Running as one script makes read-check-increment atomic: concurrent requests cannot both pass
 * on the last remaining slot.
 */
const SLIDING_WINDOW_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local current = math.floor(now / window)
local elapsed = now - current * window
local cur = tonumber(redis.call('HGET', KEYS[1], tostring(current)) or '0')
local prev = tonumber(redis.call('HGET', KEYS[1], tostring(current - 1)) or '0')
local estimated = prev * ((window - elapsed) / window) + cur

if estimated + 1 > limit then
  local retry
  if cur + 1 > limit then
    retry = window - elapsed
  else
    -- Solve prev * (window - e) / window + cur + 1 <= limit for the elapsed time e.
    retry = math.ceil(window * (1 - (limit - cur - 1) / prev) - elapsed)
  end
  return {0, 0, math.max(retry, 1)}
end

redis.call('HINCRBY', KEYS[1], tostring(current), 1)
for _, field in ipairs(redis.call('HKEYS', KEYS[1])) do
  if tonumber(field) < current - 1 then redis.call('HDEL', KEYS[1], field) end
end
redis.call('PEXPIRE', KEYS[1], window * 2)
return {1, math.max(0, math.floor(limit - estimated - 1)), 0}
`;

const SCRIPT_SHA = createHash('sha1').update(SLIDING_WINDOW_SCRIPT).digest('hex');
const resultSchema = z.tuple([z.number(), z.number(), z.number()]);

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

export function createRedisRateLimiter(redis: Redis): RateLimiter {
  // EVALSHA sends a 40-byte hash instead of the script body. Redis drops its script cache on
  // restart or failover, so NOSCRIPT falls back to EVAL, which also re-caches the script.
  async function run(key: string, limit: number, windowMs: number): Promise<unknown> {
    try {
      return await redis.evalsha(SCRIPT_SHA, 1, key, limit, windowMs);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
        return redis.eval(SLIDING_WINDOW_SCRIPT, 1, key, limit, windowMs);
      }
      throw err;
    }
  }

  return {
    async consume(key, limit, windowMs) {
      const [allowed, remaining, retryAfterMs] = resultSchema.parse(
        await run(key, limit, windowMs),
      );
      return { allowed: allowed === 1, remaining, retryAfterMs };
    },
  };
}
