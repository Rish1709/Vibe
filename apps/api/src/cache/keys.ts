/**
 * Every cache key in one place. The version prefix lets a deploy that changes a cached shape
 * bump the version instead of reading incompatible old values.
 */
export const CacheKeys = {
  authUser: (clerkId: string) => `v1:user:auth:${clerkId}`,
  rateLimit: (policy: string, subject: string) => `rl:${policy}:${subject}`,
};
