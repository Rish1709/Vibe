import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CacheKeys } from '../../cache/keys.js';
import { FeedConfig } from '../../config/feed.js';
import type { Redis } from '../../infra/redis.js';
import { isAfter, type FeedCursor, type FeedEntry } from './feed.types.js';

/**
 * Two placeholder members, never returned to readers. Both sort below every real entry (negative
 * scores), so they always occupy rank 0 and trimming starts at rank 1.
 *
 * ANCHOR keeps a committed timeline's key alive. Redis deletes a sorted set when its last member goes,
 * so without it a user whose followees haven't posted yet would have no key; fan-out (which only
 * writes to existing timelines) would skip them and every read would trigger a rebuild.
 *
 * REBUILDING makes the key exist while a rebuild runs, so fan-outs from posts published mid-rebuild
 * land in it instead of being skipped (see beginRebuild).
 */
const ANCHOR = '~anchor';
const ANCHOR_SCORE = -1;
const REBUILDING = '~rebuilding';
const REBUILDING_SCORE = -2;
const REBUILD_KEY_TTL_SECONDS = 60;

/**
 * Trim keeping rank 0 (the placeholder) plus the newest `max` entries: removes ranks 1 .. N-max-1,
 * which as a negative index is -(max + 1). With N <= max + 1 the range is empty and nothing is removed.
 */
const TRIM = `redis.call('ZREMRANGEBYRANK', KEYS[1], 1, -(tonumber(ARGV[3]) + 1))`;

/** Adds one post to a timeline only if that timeline exists, then trims to the cap. */
const ADD_IF_EXISTS = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[2])
${TRIM}
return 1
`;

/**
 * Finishes a rebuild only if no invalidation happened since it started (version unchanged).
 * Otherwise the data it computed may include an author the user just unfollowed, so the key is dropped
 * and the next read rebuilds again. ARGV: expectedVersion, ttl, maxEntries, score1, id1, score2, id2...
 */
const COMMIT_REBUILD = `
local current = redis.call('GET', KEYS[2]) or '0'
if current ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('ZADD', KEYS[1], ${ANCHOR_SCORE}, '${ANCHOR}')
redis.call('ZREM', KEYS[1], '${REBUILDING}')
for i = 4, #ARGV, 2 do
  redis.call('ZADD', KEYS[1], ARGV[i], ARGV[i + 1])
end
${TRIM}
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

const isPlaceholder = (member: string) => member === ANCHOR || member === REBUILDING;

const sha1 = (script: string) => createHash('sha1').update(script).digest('hex');
const SCRIPTS = {
  addIfExists: { body: ADD_IF_EXISTS, sha: sha1(ADD_IF_EXISTS) },
  commitRebuild: { body: COMMIT_REBUILD, sha: sha1(COMMIT_REBUILD) },
};

type Parsed<S extends readonly z.ZodType[]> = { [K in keyof S]: z.output<S[K]> };

/**
 * Checks a MULTI/pipeline result: throws the first command error, then validates the leading results
 * against `schemas` (trailing results, e.g. EXPIRE acknowledgements, are ignored).
 */
function unwrap<const S extends readonly z.ZodType[]>(
  results: [Error | null, unknown][] | null,
  schemas: S,
): Parsed<S> {
  if (!results) throw new Error('Redis transaction was aborted');
  const failed = results.find(([err]) => err);
  if (failed?.[0]) throw failed[0];
  return schemas.map((schema, i) => schema.parse(results[i]?.[1])) as Parsed<S>;
}

/** Extra entries read past the cursor to skip ties at the cursor's exact millisecond. */
const TIE_SLACK = 20;

/**
 * Redis-backed home timelines: one sorted set of post ids per active user.
 *
 * Only ids are stored (~64 bytes per entry), never post bodies: hydration loads current content and
 * re-checks visibility, so a timeline can be stale or incomplete but never leaks or shows edited-away
 * text. Timelines are a cache. MongoDB stays the source of truth, and any timeline can be dropped and
 * rebuilt at any time.
 */
export function createTimelineStore(redis: Redis) {
  async function evalScript(
    script: keyof typeof SCRIPTS,
    keys: string[],
    args: (string | number)[],
  ) {
    const { body, sha } = SCRIPTS[script];
    try {
      return await redis.evalsha(sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('NOSCRIPT')) {
        return redis.eval(body, keys.length, ...keys, ...args);
      }
      throw err;
    }
  }

  return {
    /**
     * 'rebuilding' covers both a rebuild in progress and one that crashed after beginRebuild (its
     * half-built key expires within REBUILD_KEY_TTL_SECONDS). Either way, readers use MongoDB.
     */
    async state(userId: string): Promise<'missing' | 'rebuilding' | 'ready'> {
      const key = CacheKeys.timeline(userId);
      const [exists, rebuilding] = unwrap(
        await redis.multi().exists(key).zscore(key, REBUILDING).exec(),
        [z.number(), z.string().nullable()] as const,
      );
      if (exists === 0) return 'missing';
      return rebuilding === null ? 'ready' : 'rebuilding';
    },

    /**
     * Reads up to `limit` entries after `cursor`, newest first. Also returns whether the timeline is
     * complete (holds the user's entire history, i.e. it was never trimmed) so the caller knows if an
     * exhausted timeline means "end of feed" or "continue from the database".
     * Reading refreshes the TTL: active users keep their timelines, inactive ones expire.
     */
    async read(userId: string, cursor: FeedCursor | null, limit: number) {
      const key = CacheKeys.timeline(userId);
      const max = cursor ? String(cursor.t) : '+inf';
      const [range, size] = unwrap(
        await redis
          .multi()
          .zrange(key, max, '-inf', 'BYSCORE', 'REV', 'LIMIT', 0, limit + TIE_SLACK, 'WITHSCORES')
          .zcard(key)
          .expire(key, FeedConfig.timelineTtlSeconds)
          .exec(),
        [z.array(z.string()), z.number()] as const,
      );

      const entries: FeedEntry[] = [];
      for (let i = 0; i < range.length; i += 2) {
        const id = range[i] as string;
        const t = Number(range[i + 1]);
        if (isPlaceholder(id)) continue;
        const entry = { id, t };
        if (isAfter(entry, cursor)) entries.push(entry);
        if (entries.length === limit) break;
      }
      // Minus the anchor. Below the cap means nothing was ever trimmed: the timeline is the whole history.
      return { entries, complete: size - 1 < FeedConfig.timelineMaxEntries };
    },

    /** Fan-out step: adds a post to each follower's timeline that exists (active readers only). */
    async addToExisting(userIds: string[], entry: FeedEntry): Promise<number> {
      if (userIds.length === 0) return 0;
      const pipeline = redis.pipeline();
      for (const userId of userIds) {
        pipeline.evalsha(
          SCRIPTS.addIfExists.sha,
          1,
          CacheKeys.timeline(userId),
          entry.t,
          entry.id,
          FeedConfig.timelineMaxEntries,
        );
      }
      const results = (await pipeline.exec()) ?? [];
      // After a Redis restart the script cache is empty; retry the batch with EVAL (also re-caches it).
      if (results.some(([err]) => err?.message.startsWith('NOSCRIPT'))) {
        let added = 0;
        for (const userId of userIds) {
          added += Number(
            await evalScript(
              'addIfExists',
              [CacheKeys.timeline(userId)],
              [entry.t, entry.id, FeedConfig.timelineMaxEntries],
            ),
          );
        }
        return added;
      }
      const failure = results.find(([err]) => err);
      if (failure?.[0]) throw failure[0];
      return results.reduce((sum, [, added]) => sum + Number(added), 0);
    },

    async removeFromAll(userIds: string[], postId: string): Promise<void> {
      if (userIds.length === 0) return;
      const pipeline = redis.pipeline();
      for (const userId of userIds) pipeline.zrem(CacheKeys.timeline(userId), postId);
      await pipeline.exec();
    },

    /**
     * Starts a rebuild. Returns null if another rebuild for this user is in progress (the caller should
     * serve from the database instead of stampeding). Otherwise the key now exists (REBUILDING), so
     * fan-outs from posts published during the rebuild are captured rather than skipped.
     *
     * The lock only prevents a stampede; correctness doesn't depend on it. If it expires mid-rebuild
     * and a second rebuild starts, both read MongoDB and both commits are guarded by the version check.
     */
    async beginRebuild(userId: string): Promise<{ version: string } | null> {
      const acquired = await redis.set(
        CacheKeys.timelineRebuildLock(userId),
        '1',
        'PX',
        FeedConfig.rebuildLockMs,
        'NX',
      );
      if (acquired !== 'OK') return null;
      const [version] = unwrap(
        await redis
          .multi()
          .get(CacheKeys.timelineVersion(userId))
          .zadd(CacheKeys.timeline(userId), REBUILDING_SCORE, REBUILDING)
          // Short: if this process dies before committing, the half-built key disappears by itself.
          .expire(CacheKeys.timeline(userId), REBUILD_KEY_TTL_SECONDS)
          .exec(),
        [z.string().nullable()] as const,
      );
      return { version: version ?? '0' };
    },

    /** Gives up on a rebuild that failed, so the next read retries instead of seeing a sentinel. */
    async abortRebuild(userId: string): Promise<void> {
      await redis.del(CacheKeys.timeline(userId), CacheKeys.timelineRebuildLock(userId));
    },

    /** Writes rebuilt entries unless the timeline was invalidated meanwhile. Returns whether it committed. */
    async commitRebuild(userId: string, version: string, entries: FeedEntry[]): Promise<boolean> {
      try {
        const committed = await evalScript(
          'commitRebuild',
          [CacheKeys.timeline(userId), CacheKeys.timelineVersion(userId)],
          [
            version,
            FeedConfig.timelineTtlSeconds,
            FeedConfig.timelineMaxEntries,
            ...entries.flatMap((entry) => [entry.t, entry.id]),
          ],
        );
        return committed === 1;
      } finally {
        await redis.del(CacheKeys.timelineRebuildLock(userId));
      }
    },

    /**
     * Drops timelines after a follow-graph change. Deleting (rather than patching) is simple and
     * always correct: the next read rebuilds from MongoDB. The version bump makes any rebuild already in
     * flight discard its now-stale result.
     */
    async invalidate(userIds: string[]): Promise<void> {
      if (userIds.length === 0) return;
      const pipeline = redis.pipeline();
      for (const userId of userIds) {
        pipeline.incr(CacheKeys.timelineVersion(userId));
        pipeline.expire(CacheKeys.timelineVersion(userId), FeedConfig.timelineTtlSeconds);
        pipeline.del(CacheKeys.timeline(userId), CacheKeys.feedAuthors(userId));
      }
      await pipeline.exec();
    },
  };
}

export type TimelineStore = ReturnType<typeof createTimelineStore>;
