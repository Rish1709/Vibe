import type { PageMeta, PostDto, ToggleResultDto, UserListItemDto } from '@vibe/shared';
import { Types } from 'mongoose';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { loadVisiblePost } from '../posts/post.access.js';
import { hydratePosts } from '../posts/post.hydrator.js';
import { PostModel, type PostRecord } from '../posts/post.model.js';
import { getRelationships } from '../relationships/relationship.service.js';
import { findUserSummaries } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import {
  BookmarkModel,
  LikeModel,
  type BookmarkRecord,
  type LikeRecord,
} from './engagement.models.js';

interface PageInput {
  cursor?: string | undefined;
  limit: number;
}

/**
 * Upserts an edge; true if this call inserted it. Concurrent upserts on a unique key can surface
 * E11000 to the loser; that means the edge already exists, which is the outcome we wanted.
 */
async function upsertEdge(upsert: () => Promise<{ upsertedCount: number }>): Promise<boolean> {
  try {
    return (await upsert()).upsertedCount === 1;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

async function adjustLikes(postId: Types.ObjectId, delta: 1 | -1): Promise<number> {
  const updated = await PostModel.findOneAndUpdate(
    { _id: postId },
    { $inc: { 'counts.likes': delta } },
    { returnDocument: 'after', projection: { counts: 1 } },
  ).lean<Pick<PostRecord, 'counts'>>();
  return Math.max(0, updated?.counts.likes ?? 0);
}

/** Likes and bookmarks attach to originals and quotes; a repost is only a pointer to one. */
async function loadEngageablePost(viewer: AuthUser, postId: string): Promise<PostRecord> {
  const { post } = await loadVisiblePost(viewer.id, postId);
  if (post.kind === 'repost') throw Errors.badRequest('Interact with the original post instead');
  return post;
}

export type EngagementService = ReturnType<typeof createEngagementService>;

export function createEngagementService() {
  return {
    /**
     * Idempotent and race-safe without a transaction. The upsert either inserts the edge or matches the
     * existing one; only the request that inserted (upsertedCount = 1) increments the counter. Twenty
     * concurrent likes from one user therefore produce one like and a count of one.
     */
    async like(viewer: AuthUser, postId: string): Promise<ToggleResultDto> {
      const post = await loadEngageablePost(viewer, postId);
      const inserted = await upsertEdge(() =>
        LikeModel.updateOne(
          { postId: post._id, userId: new Types.ObjectId(viewer.id) },
          { $setOnInsert: { createdAt: new Date() } },
          { upsert: true },
        ),
      );
      const count = inserted ? await adjustLikes(post._id, 1) : Math.max(0, post.counts.likes);
      return { active: true, count };
    },

    /** Mirror image: only the request that actually deleted the edge decrements. */
    async unlike(viewer: AuthUser, postId: string): Promise<ToggleResultDto> {
      const post = await loadEngageablePost(viewer, postId);
      const removed = await LikeModel.deleteOne({ postId: post._id, userId: viewer.id });
      const count =
        removed.deletedCount === 1
          ? await adjustLikes(post._id, -1)
          : Math.max(0, post.counts.likes);
      return { active: false, count };
    },

    async listLikers(
      viewer: AuthUser,
      postId: string,
      { cursor, limit }: PageInput,
    ): Promise<{ items: UserListItemDto[]; meta: PageMeta }> {
      const post = await loadEngageablePost(viewer, postId);
      const rows = await LikeModel.find({ postId: post._id, ...keysetFilter(cursor, 'desc') })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<LikeRecord[]>();
      const { items: likes, meta } = keysetPage(rows, limit);
      const ids = likes.map((like) => like.userId.toHexString());
      const [summaries, relationships] = await Promise.all([
        findUserSummaries(ids),
        getRelationships(viewer.id, ids),
      ]);
      const items = ids.flatMap((id): UserListItemDto[] => {
        const summary = summaries.get(id);
        const rel = relationships.get(id);
        // Hide people the viewer blocked or who blocked the viewer.
        if (!summary || !rel || rel.blockedByViewer || rel.blockingViewer) return [];
        return [rel.isSelf ? summary : { ...summary, viewer: { following: rel.following } }];
      });
      return { items, meta };
    },

    async bookmark(viewer: AuthUser, postId: string): Promise<ToggleResultDto> {
      const post = await loadEngageablePost(viewer, postId);
      await upsertEdge(() =>
        BookmarkModel.updateOne(
          { userId: new Types.ObjectId(viewer.id), postId: post._id },
          { $setOnInsert: { createdAt: new Date() } },
          { upsert: true },
        ),
      );
      return { active: true, count: 0 };
    },

    /** No visibility check: you can always remove your own bookmark, even of a now-hidden post. */
    async unbookmark(viewer: AuthUser, postId: string): Promise<ToggleResultDto> {
      await BookmarkModel.deleteOne({ userId: viewer.id, postId });
      return { active: false, count: 0 };
    },

    /**
     * Saved posts in the order they were saved. Paginated on the bookmark edge, then hydrated; posts
     * that were deleted or became invisible are dropped, so a page can be shorter than `limit` while
     * `nextCursor` still points onward.
     */
    async listBookmarks(
      viewer: AuthUser,
      { cursor, limit }: PageInput,
    ): Promise<{ items: PostDto[]; meta: PageMeta }> {
      const rows = await BookmarkModel.find({
        userId: new Types.ObjectId(viewer.id),
        ...keysetFilter(cursor, 'desc'),
      })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<BookmarkRecord[]>();
      const { items: bookmarks, meta } = keysetPage(rows, limit);
      const posts = await PostModel.find({
        _id: { $in: bookmarks.map((bookmark) => bookmark.postId) },
        deletedAt: null,
      }).lean<PostRecord[]>();
      const byId = new Map(posts.map((post) => [post._id.toHexString(), post]));
      const ordered = bookmarks.flatMap((bookmark) => {
        const post = byId.get(bookmark.postId.toHexString());
        return post ? [post] : [];
      });
      return { items: await hydratePosts(viewer.id, ordered), meta };
    },
  };
}
