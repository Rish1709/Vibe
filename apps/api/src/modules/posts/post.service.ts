import type {
  CreatePostInput,
  PageMeta,
  PostDto,
  ToggleResultDto,
  UpdatePostInput,
} from '@vibe/shared';
import { Types } from 'mongoose';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { canReshare, canSeeProfile, canViewContent } from '../../policies/visibility.js';
import type { FeedWriter } from '../feed/feed.writer.js';
import { getRelationship } from '../relationships/relationship.service.js';
import { UserModel } from '../users/user.model.js';
import { requireActiveUser } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import { extractHashtags } from './hashtags.js';
import { loadVisiblePost } from './post.access.js';
import { hydratePosts } from './post.hydrator.js';
import { PostModel, type PostRecord } from './post.model.js';

/** Reposts and quotes target the underlying original, so chains never form. */
const reshareTarget = (post: PostRecord) =>
  post.kind === 'repost' && post.sharedPostId
    ? post.sharedPostId.toHexString()
    : post._id.toHexString();

async function incrementPostCount(userId: string, delta: 1 | -1) {
  await UserModel.updateOne({ _id: userId }, { $inc: { 'counts.posts': delta } });
}

async function incrementReposts(postId: Types.ObjectId | string, delta: 1 | -1) {
  return PostModel.findOneAndUpdate(
    { _id: postId },
    { $inc: { 'counts.reposts': delta } },
    { returnDocument: 'after', projection: { counts: 1 } },
  ).lean<Pick<PostRecord, 'counts'>>();
}

export type PostService = ReturnType<typeof createPostService>;

export function createPostService({ feed }: { feed: FeedWriter }) {
  async function hydrateOne(viewer: AuthUser, post: PostRecord): Promise<PostDto> {
    const [dto] = await hydratePosts(viewer.id, [post]);
    if (!dto) throw Errors.notFound('Post not found');
    return dto;
  }

  /** Loads a post the viewer may reshare (public, visible), resolving reposts to their original. */
  async function loadReshareable(viewer: AuthUser, postId: string): Promise<PostRecord> {
    let visible = await loadVisiblePost(viewer.id, postId);
    if (visible.post.kind === 'repost') {
      visible = await loadVisiblePost(viewer.id, reshareTarget(visible.post));
    }
    if (!canReshare(visible.rel, visible.author)) {
      throw Errors.forbidden("Posts from private accounts can't be shared");
    }
    return visible.post;
  }

  return {
    async create(viewer: AuthUser, input: CreatePostInput): Promise<PostDto> {
      const quoted = input.quotedPostId ? await loadReshareable(viewer, input.quotedPostId) : null;
      const fanoutSkipped = await feed.shouldSkipFanout(viewer.id);
      const created = await PostModel.create({
        authorId: viewer.id,
        ...(fanoutSkipped && { fanoutSkipped }),
        kind: quoted ? 'quote' : 'original',
        text: input.text,
        hashtags: extractHashtags(input.text),
        sharedPostId: quoted?._id ?? null,
      });
      await Promise.all([
        incrementPostCount(viewer.id, 1),
        quoted ? incrementReposts(quoted._id, 1) : Promise.resolve(),
        feed.onPostPublished(created),
      ]);
      return hydrateOne(viewer, created.toObject<PostRecord>());
    },

    async get(viewer: AuthUser, postId: string): Promise<PostDto> {
      const { post } = await loadVisiblePost(viewer.id, postId);
      return hydrateOne(viewer, post);
    },

    /** Only the author's own originals and quotes; reposts have no text of their own. */
    async update(viewer: AuthUser, postId: string, input: UpdatePostInput): Promise<PostDto> {
      const updated = await PostModel.findOneAndUpdate(
        { _id: postId, authorId: viewer.id, deletedAt: null, kind: { $ne: 'repost' } },
        { $set: { text: input.text, hashtags: extractHashtags(input.text), editedAt: new Date() } },
        { returnDocument: 'after' },
      ).lean<PostRecord>();
      // Not found and not-yours are indistinguishable: both mean "you can't edit this".
      if (!updated) throw Errors.notFound('Post not found');
      return hydrateOne(viewer, updated);
    },

    /**
     * Soft delete. The conditional update (deletedAt: null) makes a double delete count once.
     * Likes, comments and bookmarks pointing at it are hidden by hydration immediately and purged by
     * an idempotent background job (Phase 7).
     */
    async remove(viewer: AuthUser, postId: string): Promise<void> {
      const deleted = await PostModel.findOneAndUpdate(
        { _id: postId, authorId: viewer.id, deletedAt: null, kind: { $ne: 'repost' } },
        { $set: { deletedAt: new Date() } },
        { projection: { kind: 1, sharedPostId: 1, authorId: 1, createdAt: 1 } },
      ).lean<Pick<PostRecord, '_id' | 'kind' | 'sharedPostId' | 'authorId' | 'createdAt'>>();
      if (!deleted) throw Errors.notFound('Post not found');
      await Promise.all([
        incrementPostCount(viewer.id, -1),
        deleted.kind === 'quote' && deleted.sharedPostId
          ? incrementReposts(deleted.sharedPostId, -1)
          : Promise.resolve(),
        feed.onPostRemoved(deleted),
      ]);
    },

    async listByAuthor(
      viewer: AuthUser,
      authorId: string,
      { cursor, limit }: { cursor?: string | undefined; limit: number },
    ): Promise<{ items: PostDto[]; meta: PageMeta }> {
      const author = await requireActiveUser(authorId);
      const rel = await getRelationship(viewer.id, authorId);
      if (!canSeeProfile(rel)) throw Errors.notFound('User not found');
      if (!canViewContent(rel, author)) throw Errors.forbidden('This account is private');

      // Index {authorId, createdAt, _id}: an equality prefix then a range scan of limit + 1 entries.
      const rows = await PostModel.find({
        authorId: new Types.ObjectId(authorId),
        deletedAt: null,
        ...keysetFilter(cursor, 'desc'),
      })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<PostRecord[]>();
      const { items, meta } = keysetPage(rows, limit);
      return { items: await hydratePosts(viewer.id, items), meta };
    },

    /** Idempotent: the partial unique index allows one plain repost per user per post. */
    async repost(viewer: AuthUser, postId: string): Promise<ToggleResultDto> {
      const target = await loadReshareable(viewer, postId);
      let created;
      try {
        const fanoutSkipped = await feed.shouldSkipFanout(viewer.id);
        created = await PostModel.create({
          authorId: viewer.id,
          kind: 'repost',
          sharedPostId: target._id,
          ...(fanoutSkipped && { fanoutSkipped }),
        });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        return { active: true, count: Math.max(0, target.counts.reposts) };
      }
      const [updated] = await Promise.all([
        incrementReposts(target._id, 1),
        // A repost appears in the reposter's followers' feeds like any post.
        feed.onPostPublished(created),
      ]);
      return { active: true, count: Math.max(0, updated?.counts.reposts ?? 0) };
    },

    /** Reposts are hard-deleted so the unique constraint frees up for a later repost. */
    async unrepost(viewer: AuthUser, postId: string): Promise<ToggleResultDto> {
      const removed = await PostModel.findOneAndDelete({
        authorId: viewer.id,
        kind: 'repost',
        sharedPostId: postId,
      }).lean();
      if (removed) await feed.onPostRemoved(removed);
      const updated = removed
        ? await incrementReposts(postId, -1)
        : await PostModel.findById(postId, { counts: 1 }).lean<Pick<PostRecord, 'counts'>>();
      return { active: false, count: Math.max(0, updated?.counts.reposts ?? 0) };
    },
  };
}
