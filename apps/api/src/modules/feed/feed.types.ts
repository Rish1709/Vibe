/** A feed candidate: just enough to order and paginate; hydration turns it into a PostDto later. */
export interface FeedEntry {
  id: string;
  /** createdAt in epoch milliseconds (the timeline's sorted-set score). */
  t: number;
}

/** Position after which the next page starts. Shared by every source, so pages can mix sources. */
export interface FeedCursor {
  t: number;
  id: string;
}

/**
 * Total order used everywhere: newest first, ties broken by id descending. MongoDB sorts with
 * { createdAt: -1, _id: -1 } and Redis orders equal scores by member (hex id) descending in REV mode,
 * so all sources agree and merging them is a plain k-way merge.
 */
export function compareDesc(a: FeedEntry, b: FeedEntry): number {
  if (a.t !== b.t) return b.t - a.t;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True if `entry` comes strictly after `cursor` in feed order (i.e. belongs on a later page). */
export function isAfter(entry: FeedEntry, cursor: FeedCursor | null): boolean {
  if (!cursor) return true;
  return entry.t < cursor.t || (entry.t === cursor.t && entry.id < cursor.id);
}

/** Merges already-sorted lists, dropping duplicates (a post can arrive from two sources). */
export function mergeEntries(...lists: FeedEntry[][]): FeedEntry[] {
  const seen = new Set<string>();
  const merged: FeedEntry[] = [];
  for (const entry of lists.flat().sort(compareDesc)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

/**
 * Orders candidates. Chronological today; a ranking model (engagement, affinity, recency decay)
 * plugs in here. Note that a non-chronological ranker needs score-based cursors, since "everything
 * older than t" no longer describes the next page.
 */
export interface FeedRanker {
  rank(entries: FeedEntry[]): FeedEntry[];
}

export const chronologicalRanker: FeedRanker = { rank: (entries) => entries };
