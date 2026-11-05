/**
 * Every cache key in one place. The version prefix lets a deploy that changes a cached shape
 * bump the version instead of reading incompatible old values.
 */
export const CacheKeys = {
  authUser: (clerkId: string) => `v1:user:auth:${clerkId}`,
  rateLimit: (policy: string, subject: string) => `rl:${policy}:${subject}`,
  /** Sorted set of post ids (score = createdAt ms): the user's precomputed home timeline. */
  timeline: (userId: string) => `v1:feed:tl:${userId}`,
  /** Bumped on every invalidation, so a rebuild that started before it can detect it is stale. */
  timelineVersion: (userId: string) => `v1:feed:ver:${userId}`,
  timelineRebuildLock: (userId: string) => `v1:feed:lock:${userId}`,
  /** The viewer's followees, split into fanned-out authors and pulled-at-read celebrities. */
  feedAuthors: (userId: string) => `v1:feed:authors:${userId}`,
  /** Explore's trending hashtags: one list for everyone. */
  trendingHashtags: () => 'v1:explore:trending',
  /** Follow-suggestion candidates for a viewer (filtered live on read). */
  followSuggestions: (userId: string) => `v1:explore:suggest:${userId}`,
};
