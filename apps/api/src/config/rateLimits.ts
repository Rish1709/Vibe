import type { RateLimitPolicy } from '../middleware/rateLimit.js';

const MINUTE = 60_000;

/**
 * Starting points sized for interactive use, not measured capacity limits.
 * Revisit with load-test data (Phase 9).
 */
export const RateLimits = {
  /** Before authentication, per IP. Generous because many users can share one NAT address. */
  anonymous: { name: 'anon', limit: 600, windowMs: MINUTE },
  /** Every authenticated request, per user. */
  authenticated: { name: 'user', limit: 300, windowMs: MINUTE },
  /** Profile, settings and onboarding writes. */
  accountWrites: { name: 'account-write', limit: 20, windowMs: MINUTE },
  /** Debounced on the client; this bounds username enumeration. */
  usernameCheck: { name: 'username-check', limit: 60, windowMs: MINUTE },
} satisfies Record<string, RateLimitPolicy>;
