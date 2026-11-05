import type { NotificationDto, PageMeta } from '@vibe/shared';
import { Types } from 'mongoose';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { CommentModel } from '../comments/comment.model.js';
import { PostModel, type PostRecord } from '../posts/post.model.js';
import { getRelationships } from '../relationships/relationship.service.js';
import { findUserSummaries } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import { NotificationModel, type NotificationRecord } from './notification.model.js';
import { dedupeKeyOf, type NotificationEvent } from './notification.queue.js';

interface PageInput {
  cursor?: string | undefined;
  limit: number;
}

const SNIPPET_LENGTH = 100;
const oid = (id: string | Types.ObjectId) => new Types.ObjectId(id);
const hex = (id: Types.ObjectId) => id.toHexString();
const snippet = (text: string) =>
  text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH - 1)}…` : text;

/** Types that point at a post and are meaningless once it's gone. */
const POST_TYPES = new Set(['like', 'comment', 'reply']);

export type NotificationService = ReturnType<typeof createNotificationService>;

export function createNotificationService({ realtime }: { realtime: RealtimePublisher }) {
  async function unreadCount(userId: string): Promise<number> {
    return NotificationModel.countDocuments({ recipientId: oid(userId), readAt: null });
  }

  /** Pushes the new count when a removed notification was still unread. */
  async function afterRemoval(recipientId: string, removedUnread: boolean) {
    if (removedUnread) {
      realtime.toUser(recipientId, 'notification:count', {
        unreadCount: await unreadCount(recipientId),
      });
    }
  }

  return {
    unreadCount: (viewer: AuthUser) => unreadCount(viewer.id),

    /**
     * Newest first, hydrated in a constant number of queries per page (actors, relationships, posts,
     * comments). Visibility is re-checked at read time: actors who blocked or were blocked by the
     * viewer, deleted accounts and deleted posts or comments drop out, so a page may be short.
     */
    async list(
      viewer: AuthUser,
      { cursor, limit }: PageInput,
    ): Promise<{ items: NotificationDto[]; meta: PageMeta }> {
      const rows = await NotificationModel.find({
        recipientId: oid(viewer.id),
        ...keysetFilter(cursor, 'desc'),
      })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<NotificationRecord[]>();
      const { items, meta } = keysetPage(rows, limit);

      const actorIds = items.map((item) => hex(item.actorId));
      const postIds = items.flatMap((item) => (item.postId ? [item.postId] : []));
      const commentIds = items.flatMap((item) => (item.commentId ? [item.commentId] : []));
      const [actors, relationships, posts, comments] = await Promise.all([
        findUserSummaries(actorIds),
        getRelationships(viewer.id, actorIds),
        PostModel.find({ _id: { $in: postIds }, deletedAt: null }, { text: 1, media: 1 }).lean<
          Pick<PostRecord, '_id' | 'text' | 'media'>[]
        >(),
        CommentModel.find({ _id: { $in: commentIds }, deletedAt: null }, { text: 1 }).lean<
          { _id: Types.ObjectId; text: string }[]
        >(),
      ]);
      const postById = new Map(posts.map((post) => [hex(post._id), post]));
      const commentById = new Map(comments.map((comment) => [hex(comment._id), comment]));

      const dtos = items.flatMap((item): NotificationDto[] => {
        const actorId = hex(item.actorId);
        const actor = actors.get(actorId);
        const rel = relationships.get(actorId);
        if (!actor || !rel || rel.blockedByViewer || rel.blockingViewer) return [];
        const post = item.postId ? postById.get(hex(item.postId)) : undefined;
        const comment = item.commentId ? commentById.get(hex(item.commentId)) : undefined;
        if (POST_TYPES.has(item.type) && !post) return [];
        if (item.commentId && !comment) return [];
        const thumb = post?.media?.[0];
        return [
          {
            id: hex(item._id),
            type: item.type,
            actor,
            post: post
              ? {
                  id: hex(post._id),
                  text: snippet(post.text),
                  thumbnailUrl: thumb
                    ? thumb.kind === 'image'
                      ? thumb.url
                      : (thumb.thumbnailUrl ?? null)
                    : null,
                }
              : null,
            comment: comment ? { id: hex(comment._id), text: snippet(comment.text) } : null,
            read: item.readAt !== null,
            createdAt: item.createdAt.toISOString(),
          },
        ];
      });
      return { items: dtos, meta };
    },

    /** Marks everything read, and clears the badge in the viewer's other tabs. */
    async markAllRead(viewer: AuthUser): Promise<void> {
      await NotificationModel.updateMany(
        { recipientId: oid(viewer.id), readAt: null },
        { $set: { readAt: new Date() } },
      );
      realtime.toUser(viewer.id, 'notification:count', { unreadCount: 0 });
    },

    /**
     * Removes the notification for an undone action (unlike, unfollow, cancelled request). Call it
     * after deleting the source edge: see the "insert, then check" note in the processor.
     */
    async retract(event: NotificationEvent): Promise<void> {
      const removed = await NotificationModel.findOneAndDelete(
        { recipientId: oid(event.recipientId), dedupeKey: dedupeKeyOf(event) },
        { projection: { readAt: 1 } },
      ).lean();
      await afterRemoval(event.recipientId, removed !== null && removed.readAt === null);
    },

    /** Removes notifications about a deleted comment (its own, and replies counted under it). */
    async retractForComment(commentId: string): Promise<void> {
      const removed = await NotificationModel.find(
        { commentId: oid(commentId) },
        { recipientId: 1, readAt: 1 },
      ).lean();
      if (removed.length === 0) return;
      await NotificationModel.deleteMany({ commentId: oid(commentId) });
      const unreadRecipients = new Set(
        removed.filter((item) => item.readAt === null).map((item) => hex(item.recipientId)),
      );
      await Promise.all([...unreadRecipients].map((id) => afterRemoval(id, true)));
    },
  };
}
