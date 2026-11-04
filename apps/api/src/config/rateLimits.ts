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
  /** Follow, unfollow, block: also bounds follow-spam. */
  graphWrites: { name: 'graph-write', limit: 60, windowMs: MINUTE },
  /** Creating, editing and deleting posts. */
  postWrites: { name: 'post-write', limit: 30, windowMs: MINUTE },
  /** Likes, bookmarks, reposts: cheap toggles users tap quickly. */
  engagementWrites: { name: 'engagement-write', limit: 120, windowMs: MINUTE },
  commentWrites: { name: 'comment-write', limit: 30, windowMs: MINUTE },
} satisfies Record<string, RateLimitPolicy>;
