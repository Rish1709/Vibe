/**
 * Feed tuning. Values are starting points, not measured optima; see INTERVIEW/caching-strategy.md and the
 * feed benchmark (scripts/bench-feed.ts) for how they were chosen.
 */
export const FeedConfig = {
  /**
   * Entries kept per Redis timeline. ~800 posts covers days of scrolling for typical users; older
   * pages fall back to the database. Memory: roughly 64 bytes per entry, so ~50 KB per active user.
   */
  timelineMaxEntries: 800,
  /** Timelines of users who stop reading expire; they are rebuilt from MongoDB on their next visit. */
  timelineTtlSeconds: 7 * 24 * 3600,
  /** Only one rebuild per user at a time; concurrent requests are served straight from MongoDB. */
  rebuildLockMs: 10_000,
  /** Followers processed per fan-out batch (one Redis pipeline each). */
  fanoutBatchSize: 500,
  /** The viewer's followee list and celebrity subset, cached briefly between page loads. */
  authorSetTtlSeconds: 300,
} as const;
