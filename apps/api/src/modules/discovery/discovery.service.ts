import type { PageMeta, PostDto, SuggestedUserDto, TrendingHashtagDto } from '@vibe/shared';
import { Types } from 'mongoose';
import { z } from 'zod';
import { cacheAside } from '../../cache/cacheAside.js';
import { CacheKeys } from '../../cache/keys.js';
import type { Logger } from '../../infra/logger.js';
import type { Redis } from '../../infra/redis.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { hydratePosts } from '../posts/post.hydrator.js';
import { PostModel, type PostRecord } from '../posts/post.model.js';
import { FollowModel } from '../relationships/follow.model.js';
import { getRelationships } from '../relationships/relationship.service.js';
import { UserModel } from '../users/user.model.js';
import { findAuthors } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';

interface PageInput {
  cursor?: string | undefined;
  limit: number;
}

/** "Trending" looks at this window. A week suits a young network; busy ones would use hours. */
export const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TRENDING_LIMIT = 10;
const TRENDING_TTL_SECONDS = 300;
/** Suggestions are computed from at most this many of the viewer's (most recent) followees. */
const SUGGESTION_SEED_FOLLOWEES = 200;
const SUGGESTION_CANDIDATES = 50;
const SUGGESTION_TTL_SECONDS = 600;

const oid = (id: string) => new Types.ObjectId(id);
const hex = (id: Types.ObjectId) => id.toHexString();

const trendingSchema = z.array(
  z.object({ tag: z.string(), posts: z.number(), authors: z.number() }),
);
const candidatesSchema = z.array(z.object({ id: z.string(), mutuals: z.number() }));

/**
 * Turns free text into MongoDB `$text` terms that must all appear: each word becomes a quoted phrase,
 * and multiple phrases are ANDed. Quotes and the leading '-' (negation) are stripped from user input,
 * so the search box can't be used to inject $text operators.
 */
export function toTextSearch(query: string): string | null {
  const words = query
    .replace(/["\\]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^-+/, ''))
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .slice(0, 8);
  return words.length > 0 ? words.map((word) => `"${word}"`).join(' ') : null;
}

const SINGLE_HASHTAG = /^#([\p{L}\p{N}_]{1,50})$/u;

/** An ObjectId whose timestamp is `date`: `_id >= it` selects documents inserted since `date`. */
const objectIdAt = (date: Date) => Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

export type DiscoveryService = ReturnType<typeof createDiscoveryService>;

export function createDiscoveryService({ redis, logger }: { redis: Redis; logger: Logger }) {
  async function pageOfPosts(
    viewer: AuthUser,
    filter: Record<string, unknown>,
    { cursor, limit }: PageInput,
  ): Promise<{ items: PostDto[]; meta: PageMeta }> {
    const rows = await PostModel.find({
      ...filter,
      deletedAt: null,
      ...keysetFilter(cursor, 'desc'),
    })
      .sort(keysetSort('desc'))
      .limit(limit + 1)
      .lean<PostRecord[]>();
    const { items, meta } = keysetPage(rows, limit);
    // Hydration re-checks visibility, so private posts the viewer can't see drop out (a page may be short).
    return { items: await hydratePosts(viewer.id, items), meta };
  }

  async function hashtagPosts(viewer: AuthUser, tag: string, page: PageInput) {
    // Served by the { hashtags, createdAt, _id } index: an index range scan, newest first.
    return pageOfPosts(viewer, { hashtags: tag.toLowerCase() }, page);
  }

  /** Accounts followed by people the viewer follows, most shared first. */
  async function friendsOfFriends(viewerId: string) {
    const followees = await FollowModel.find(
      { followerId: oid(viewerId), status: 'active' },
      { followeeId: 1 },
    )
      .sort({ createdAt: -1 })
      .limit(SUGGESTION_SEED_FOLLOWEES)
      .lean();
    if (followees.length === 0) return [];
    const followeeIds = followees.map((edge) => edge.followeeId);
    const rows = await FollowModel.aggregate<{ _id: Types.ObjectId; mutuals: number }>([
      {
        $match: {
          followerId: { $in: followeeIds },
          status: 'active',
          followeeId: { $nin: [oid(viewerId), ...followeeIds] },
        },
      },
      { $group: { _id: '$followeeId', mutuals: { $sum: 1 } } },
      { $sort: { mutuals: -1, _id: 1 } },
      { $limit: SUGGESTION_CANDIDATES },
    ]);
    return rows.map((row) => ({ id: hex(row._id), mutuals: row.mutuals }));
  }

  return {
    /**
     * Posts containing every word (any case), newest first. MongoDB finds candidates by whole words,
     * then checks each phrase as a substring, so once one word matches exactly, the others may match
     * inside longer words ("ipsa" within "ipsam"). Observed on live data; it reads as loose prefixing. A lone "#tag" is a hashtag
     * lookup instead, which has its own index and is exact.
     *
     * Cost: $text can't stream results in date order, so MongoDB collects every match and sorts them.
     * Fine at this size; at scale this moves to a search engine (see the notes).
     */
    async searchPosts(viewer: AuthUser, q: string, page: PageInput) {
      const hashtag = SINGLE_HASHTAG.exec(q.trim());
      if (hashtag?.[1]) return hashtagPosts(viewer, hashtag[1], page);
      const search = toTextSearch(q);
      if (!search) return { items: [], meta: { nextCursor: null } };
      return pageOfPosts(viewer, { $text: { $search: search }, kind: { $ne: 'repost' } }, page);
    },

    hashtagPosts,

    /**
     * Most-used hashtags of the window, ranked by distinct authors (then posts), so one account
     * posting a tag a hundred times can't make it trend. Only public accounts count: a private
     * account's hashtags would otherwise leak into everyone's Explore page.
     *
     * The window is found with the `_id` index (ObjectIds start with their creation time), so no extra
     * index on createdAt is needed; createdAt is still checked, for documents with backdated ids.
     * Cached for a few minutes: everyone sees the same list, and it changes slowly.
     */
    async trending(): Promise<TrendingHashtagDto[]> {
      const result = await cacheAside({
        redis,
        logger,
        key: CacheKeys.trendingHashtags(),
        ttlSeconds: TRENDING_TTL_SECONDS,
        schema: trendingSchema,
        load: async () => {
          const since = new Date(Date.now() - TRENDING_WINDOW_MS);
          const usage = await PostModel.aggregate<{
            _id: { tag: string; author: Types.ObjectId };
            posts: number;
          }>([
            {
              $match: {
                _id: { $gte: objectIdAt(since) },
                createdAt: { $gte: since },
                deletedAt: null,
                'hashtags.0': { $exists: true },
              },
            },
            { $project: { hashtags: 1, authorId: 1 } },
            { $unwind: '$hashtags' },
            { $group: { _id: { tag: '$hashtags', author: '$authorId' }, posts: { $sum: 1 } } },
          ]);
          const authorIds = [...new Set(usage.map((row) => hex(row._id.author)))];
          const authors = await findAuthors(authorIds);
          const byTag = new Map<string, { posts: number; authors: number }>();
          for (const row of usage) {
            const author = authors.get(hex(row._id.author));
            if (!author || author.isPrivate) continue;
            const entry = byTag.get(row._id.tag) ?? { posts: 0, authors: 0 };
            entry.posts += row.posts;
            entry.authors += 1;
            byTag.set(row._id.tag, entry);
          }
          return [...byTag.entries()]
            .map(([tag, counts]) => ({ tag, ...counts }))
            .sort(
              (a, b) => b.authors - a.authors || b.posts - a.posts || a.tag.localeCompare(b.tag),
            )
            .slice(0, TRENDING_LIMIT);
        },
      });
      return result ?? [];
    },

    /**
     * Who to follow: friends of friends first, then popular accounts to fill up (new users follow
     * nobody yet). The candidate list is cached per viewer; follows, requests and blocks are filtered
     * live on every read, so someone you just followed disappears immediately.
     */
    async suggestions(viewer: AuthUser, limit: number): Promise<SuggestedUserDto[]> {
      const candidates =
        (await cacheAside({
          redis,
          logger,
          key: CacheKeys.followSuggestions(viewer.id),
          ttlSeconds: SUGGESTION_TTL_SECONDS,
          schema: candidatesSchema,
          load: async () => {
            const fof = await friendsOfFriends(viewer.id);
            if (fof.length >= SUGGESTION_CANDIDATES) return fof;
            const popular = await UserModel.find(
              { deletedAt: null, username: { $type: 'string' } },
              { _id: 1 },
            )
              .sort({ 'counts.followers': -1, _id: 1 })
              .limit(SUGGESTION_CANDIDATES)
              .lean();
            const seen = new Set(fof.map((candidate) => candidate.id));
            const fill = popular
              .map((user) => ({ id: hex(user._id), mutuals: 0 }))
              .filter((candidate) => !seen.has(candidate.id));
            return [...fof, ...fill].slice(0, SUGGESTION_CANDIDATES);
          },
        })) ?? [];

      const ids = candidates.map((candidate) => candidate.id);
      const [authors, relationships] = await Promise.all([
        findAuthors(ids),
        getRelationships(viewer.id, ids),
      ]);
      return candidates
        .flatMap((candidate): SuggestedUserDto[] => {
          const author = authors.get(candidate.id);
          const rel = relationships.get(candidate.id);
          if (!author || !rel || rel.isSelf) return [];
          // Already following or requested, or blocked either way: not a suggestion.
          if (rel.following !== 'none' || rel.blockedByViewer || rel.blockingViewer) return [];
          return [
            {
              ...author.summary,
              isPrivate: author.isPrivate,
              viewer: { following: rel.following },
              mutuals: candidate.mutuals,
            },
          ];
        })
        .slice(0, limit);
    },
  };
}
