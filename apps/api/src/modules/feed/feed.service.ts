import type { PageMeta, PostDto } from '@vibe/shared';
import { Types } from 'mongoose';
import { z } from 'zod';
import { cacheAside } from '../../cache/cacheAside.js';
import { CacheKeys } from '../../cache/keys.js';
import { FeedConfig } from '../../config/feed.js';
import type { Logger } from '../../infra/logger.js';
import type { Redis } from '../../infra/redis.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import { hydratePosts } from '../posts/post.hydrator.js';
import { PostModel, type PostRecord } from '../posts/post.model.js';
import { FollowModel } from '../relationships/follow.model.js';
import type { AuthUser } from '../users/user.service.js';
import {
  chronologicalRanker,
  mergeEntries,
  type FeedCursor,
  type FeedEntry,
  type FeedRanker,
} from './feed.types.js';
import { pullEntries, type PullSource } from './pull.source.js';
import type { TimelineStore } from './timeline.store.js';

const objectIdHex = z.string().regex(/^[a-f\d]{24}$/i);
const feedCursorSchema = z.object({ t: z.number().int().nonnegative(), id: objectIdHex });
/** Self plus active followees: every author whose posts belong in the viewer's feed. */
const feedAuthorsSchema = z.array(objectIdHex);

export type FeedSource = 'timeline' | 'database';

export interface FeedPage {
  items: PostDto[];
  meta: PageMeta;
  /** Which path served the fanned-out part of the page; exposed for observability and tests. */
  source: FeedSource;
}

interface FeedServiceDeps {
  redis: Redis;
  logger: Logger;
  timeline: TimelineStore;
  /** Injectable for tests and benchmarks; production uses MongoDB. */
  pull?: PullSource;
  ranker?: FeedRanker;
}

export type FeedService = ReturnType<typeof createFeedService>;

/**
 * The home feed: posts by the people the viewer follows, plus the viewer's own, newest first.
 *
 * Hybrid fan-out. Most posts are pushed into followers' Redis timelines when published (see
 * feed.writer.ts), so reading a page is O(log n + page). Posts by celebrity authors are not pushed (one
 * post would mean millions of writes); they are flagged `fanoutSkipped` and pulled from MongoDB at read
 * time through a partial index that holds only them. Both lists are merged by (createdAt, _id).
 *
 * MongoDB is the source of truth throughout: a missing timeline is rebuilt from it, a trimmed
 * timeline continues from it for older pages, and if Redis is down the whole page comes from it.
 */
export function createFeedService({
  redis,
  logger,
  timeline,
  pull = pullEntries,
  ranker = chronologicalRanker,
}: FeedServiceDeps) {
  /**
   * Cached between page loads, and invalidated exactly on follow-graph changes (see FeedWriter), so the
   * TTL is only a safety net.
   */
  async function loadAuthors(viewerId: string): Promise<string[]> {
    const authors = await cacheAside({
      redis,
      logger,
      key: CacheKeys.feedAuthors(viewerId),
      ttlSeconds: FeedConfig.authorSetTtlSeconds,
      schema: feedAuthorsSchema,
      load: async () => {
        const follows = await FollowModel.find(
          { followerId: new Types.ObjectId(viewerId), status: 'active' },
          { followeeId: 1 },
        ).lean();
        return [viewerId, ...follows.map((follow) => follow.followeeId.toHexString())];
      },
    });
    // cacheAside only returns null when load does, and load always returns a value.
    return authors ?? [viewerId];
  }

  /**
   * Makes sure the viewer has a ready timeline, rebuilding it from MongoDB if needed.
   * Returns false when the timeline can't be used for this request (another request is rebuilding it,
   * or it was invalidated mid-rebuild); the caller then serves this page from MongoDB.
   */
  async function ensureTimeline(viewerId: string, authors: string[]): Promise<boolean> {
    const state = await timeline.state(viewerId);
    if (state === 'ready') return true;
    if (state === 'rebuilding') return false;

    const rebuild = await timeline.beginRebuild(viewerId);
    if (!rebuild) return false;
    try {
      const entries = await pull(authors, null, FeedConfig.timelineMaxEntries);
      return await timeline.commitRebuild(viewerId, rebuild.version, entries);
    } catch (err) {
      await timeline.abortRebuild(viewerId).catch(() => undefined);
      throw err;
    }
  }

  /** Fanned-out candidates from the timeline, continuing from MongoDB past a trimmed timeline's end. */
  async function fromTimeline(
    viewerId: string,
    authors: string[],
    cursor: FeedCursor | null,
    want: number,
  ) {
    const { entries, complete } = await timeline.read(viewerId, cursor, want);
    if (entries.length === want || complete) return entries;
    const last = entries.at(-1);
    const older = await pull(authors, last ?? cursor, want - entries.length);
    return [...entries, ...older];
  }

  async function loadPosts(viewerId: string, entries: FeedEntry[]): Promise<PostDto[]> {
    if (entries.length === 0) return [];
    const posts = await PostModel.find({
      _id: { $in: entries.map((entry) => new Types.ObjectId(entry.id)) },
      deletedAt: null,
    }).lean<PostRecord[]>();
    const byId = new Map(posts.map((post) => [post._id.toHexString(), post]));
    const ordered = entries.flatMap((entry) => {
      const post = byId.get(entry.id);
      return post ? [post] : [];
    });
    // Hydration re-checks visibility, so a stale timeline entry can never leak a post.
    return hydratePosts(viewerId, ordered);
  }

  return {
    async getFeed(
      viewer: AuthUser,
      { cursor: rawCursor, limit }: { cursor?: string | undefined; limit: number },
    ): Promise<FeedPage> {
      const cursor = rawCursor ? decodeCursor(rawCursor, feedCursorSchema) : null;
      const authors = await loadAuthors(viewer.id);
      // Fetch one extra to know whether another page exists without counting.
      const want = limit + 1;

      let source: FeedSource = 'database';
      let fanned: FeedEntry[] | null = null;
      try {
        if (await ensureTimeline(viewer.id, authors)) {
          fanned = await fromTimeline(viewer.id, authors, cursor, want);
          source = 'timeline';
        }
      } catch (err) {
        logger.warn({ err }, 'Timeline unavailable; serving feed from MongoDB');
      }
      fanned ??= await pull(authors, cursor, want);

      // Posts that were never pushed (celebrity authors at publish time), merged in at read time.
      // A partial index holds only those posts, so this stays cheap however many people are followed.
      const celebrity =
        source === 'timeline' ? await pull(authors, cursor, want, { onlyFanoutSkipped: true }) : [];
      const ranked = ranker.rank(mergeEntries(fanned, celebrity)).slice(0, want);
      const hasMore = ranked.length > limit;
      const page = ranked.slice(0, limit);
      const last = page.at(-1);

      return {
        items: await loadPosts(viewer.id, page),
        // The cursor comes from the candidate list, not the hydrated one: posts dropped by hydration
        // (deleted, now invisible) shorten a page but never break pagination.
        meta: { nextCursor: hasMore && last ? encodeCursor({ t: last.t, id: last.id }) : null },
        source,
      };
    },
  };
}
