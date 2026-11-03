import type { Request, RequestHandler } from 'express';
import { CacheKeys } from '../cache/keys.js';
import { Errors } from '../lib/errors.js';
import type { RateLimiter } from '../lib/rateLimiter.js';

export interface RateLimitPolicy {
  /** Distinguishes policies in Redis keys and logs. */
  name: string;
  limit: number;
  windowMs: number;
}

/** Authenticated requests are limited per user (fair across shared NATs); others per client IP. */
function subjectOf(req: Request): string {
  return req.user ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`;
}

/**
 * Fails open: if Redis is unavailable the request proceeds and the failure is logged.
 * Rejecting all traffic because the limiter's store is down would turn a cache outage into a full
 * outage. Endpoints where abuse is costlier than downtime (e.g. login attempts) should fail closed.
 */
export function rateLimit(limiter: RateLimiter, policy: RateLimitPolicy): RequestHandler {
  return async (req, res, next) => {
    let result;
    try {
      result = await limiter.consume(
        CacheKeys.rateLimit(policy.name, subjectOf(req)),
        policy.limit,
        policy.windowMs,
      );
    } catch (err) {
      req.log.warn({ err, policy: policy.name }, 'Rate limiter unavailable; allowing request');
      next();
      return;
    }

    res.setHeader('X-RateLimit-Limit', policy.limit);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader('Retry-After', retryAfterSeconds);
      req.log.info({ policy: policy.name }, 'Rate limit exceeded');
      throw Errors.rateLimited(retryAfterSeconds);
    }
    next();
  };
}
