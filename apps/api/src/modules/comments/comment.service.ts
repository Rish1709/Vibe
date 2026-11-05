import type { CommentDto, CreateCommentInput, PageMeta } from '@vibe/shared';
import type { Types } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { loadVisiblePost } from '../posts/post.access.js';
import { PostModel, type PostRecord } from '../posts/post.model.js';
import { getRelationships } from '../relationships/relationship.service.js';
import { findUserSummaries } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import type { NotificationHooks } from '../notifications/notification.hooks.js';
import { CommentModel, type CommentRecord } from './comment.model.js';

interface PageInput {
  cursor?: string | undefined;
  limit: number;
}

async function adjustPostComments(postId: Types.ObjectId, delta: number) {
  await PostModel.updateOne({ _id: postId }, { $inc: { 'counts.comments': delta } });
}

/** Comments live on originals and quotes; a repost is a pointer, so its thread is the original's. */
async function loadCommentablePost(viewer: AuthUser, postId: string): Promise<PostRecord> {
  const { post } = await loadVisiblePost(viewer.id, postId);
  if (post.kind === 'repost') throw Errors.badRequest('Comment on the original post instead');
  return post;
}

export type CommentService = ReturnType<typeof createCommentService>;

export function createCommentService({ notifier, notifications }: NotificationHooks) {
  /**
   * Batch hydration: one query for authors and three for relationships, whatever the page size.
   * Comments by people the viewer blocked, or who blocked the viewer, are dropped. Filtering after the
   * query (rather than `$nin` over the viewer's block list, which is unbounded) means a page can come
   * back short; `nextCursor` stays correct because it is computed from the unfiltered rows.
   */
  async function toDtos(
    viewer: AuthUser,
    post: PostRecord,
    comments: CommentRecord[],
  ): Promise<CommentDto[]> {
    const authorIds = comments.map((comment) => comment.authorId.toHexString());
    const [summaries, relationships] = await Promise.all([
      findUserSummaries(authorIds),
      getRelationships(viewer.id, authorIds),
    ]);
    const isPostAuthor = post.authorId.equals(viewer.id);
    return comments.flatMap((comment) => {
      const authorId = comment.authorId.toHexString();
      const author = summaries.get(authorId);
      const rel = relationships.get(authorId);
      if (!author || !rel || rel.blockedByViewer || rel.blockingViewer) return [];
      return [
        {
          id: comment._id.toHexString(),
          postId: comment.postId.toHexString(),
          parentId: comment.parentId?.toHexString() ?? null,
          author,
          text: comment.text,
          counts: { replies: Math.max(0, comment.counts.replies) },
          // Authors can delete their comments; post authors can moderate their threads.
          viewer: { canDelete: rel.isSelf || isPostAuthor },
          createdAt: comment.createdAt.toISOString(),
        },
      ];
    });
  }

  return {
    async create(viewer: AuthUser, postId: string, input: CreateCommentInput): Promise<CommentDto> {
      const post = await loadCommentablePost(viewer, postId);

      let rootId: Types.ObjectId | null = null;
      let rootAuthorId: Types.ObjectId | null = null;
      if (input.parentId) {
        const parent = await CommentModel.findOne(
          { _id: input.parentId, postId: post._id, deletedAt: null },
          { parentId: 1, authorId: 1 },
        ).lean();
        if (!parent) throw Errors.notFound('Comment not found');
        rootId = parent.parentId ?? parent._id;
        rootAuthorId = parent.parentId
          ? ((await CommentModel.findById(parent.parentId, { authorId: 1 }).lean())?.authorId ??
            null)
          : parent.authorId;
      }

      const created = await CommentModel.create({
        postId: post._id,
        authorId: viewer.id,
        parentId: rootId,
        text: input.text,
      });
      await Promise.all([
        adjustPostComments(post._id, 1),
        rootId
          ? CommentModel.updateOne({ _id: rootId }, { $inc: { 'counts.replies': 1 } })
          : Promise.resolve(),
      ]);
      const event = {
        actorId: viewer.id,
        postId: post._id.toHexString(),
        commentId: created._id.toHexString(),
      };
      // A reply notifies the thread's author; the post's author hears about every comment.
      if (rootAuthorId) {
        notifier.notify({ ...event, type: 'reply', recipientId: rootAuthorId.toHexString() });
      }
      if (!rootAuthorId?.equals(post.authorId)) {
        notifier.notify({ ...event, type: 'comment', recipientId: post.authorId.toHexString() });
      }
      const [dto] = await toDtos(viewer, post, [created.toObject<CommentRecord>()]);
      if (!dto) throw Errors.internal(new Error('Created comment failed to hydrate'));
      return dto;
    },

    async listTopLevel(
      viewer: AuthUser,
      postId: string,
      { cursor, limit }: PageInput,
    ): Promise<{ items: CommentDto[]; meta: PageMeta }> {
      const post = await loadCommentablePost(viewer, postId);
      const rows = await CommentModel.find({
        postId: post._id,
        parentId: null,
        deletedAt: null,
        ...keysetFilter(cursor, 'desc'),
      })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<CommentRecord[]>();
      const { items, meta } = keysetPage(rows, limit);
      return { items: await toDtos(viewer, post, items), meta };
    },

    async listReplies(
      viewer: AuthUser,
      commentId: string,
      { cursor, limit }: PageInput,
    ): Promise<{ items: CommentDto[]; meta: PageMeta }> {
      const root = await CommentModel.findOne({
        _id: commentId,
        deletedAt: null,
      }).lean<CommentRecord>();
      if (!root) throw Errors.notFound('Comment not found');
      const post = await loadCommentablePost(viewer, root.postId.toHexString());
      const rows = await CommentModel.find({
        parentId: root._id,
        deletedAt: null,
        ...keysetFilter(cursor, 'asc'),
      })
        .sort(keysetSort('asc'))
        .limit(limit + 1)
        .lean<CommentRecord[]>();
      const { items, meta } = keysetPage(rows, limit);
      return { items: await toDtos(viewer, post, items), meta };
    },

    /**
     * Soft delete by the comment's author or the post's author. Deleting a top-level comment hides
     * its replies too, so the post's count drops by 1 + replies. The conditional update makes a
     * concurrent double delete count once.
     */
    async remove(viewer: AuthUser, commentId: string): Promise<void> {
      const comment = await CommentModel.findOne({
        _id: commentId,
        deletedAt: null,
      }).lean<CommentRecord>();
      if (!comment) throw Errors.notFound('Comment not found');
      const post = await PostModel.findById(comment.postId, { authorId: 1 }).lean();
      const allowed =
        comment.authorId.equals(viewer.id) || post?.authorId.equals(viewer.id) === true;
      if (!allowed) throw Errors.forbidden('You can only delete your own comments');

      const deleted = await CommentModel.findOneAndUpdate(
        { _id: comment._id, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { projection: { parentId: 1, counts: 1 } },
      ).lean<Pick<CommentRecord, 'parentId' | 'counts'>>();
      if (!deleted) return;

      await Promise.all([
        adjustPostComments(
          comment.postId,
          -(1 + (deleted.parentId ? 0 : Math.max(0, deleted.counts.replies))),
        ),
        deleted.parentId
          ? CommentModel.updateOne({ _id: deleted.parentId }, { $inc: { 'counts.replies': -1 } })
          : Promise.resolve(),
        notifications.retractForComment(commentId),
      ]);
    },
  };
}
