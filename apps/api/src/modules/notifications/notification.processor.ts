import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import type { Logger } from '../../infra/logger.js';
import type { RealtimePublisher } from '../../realtime/publisher.js';
import { CommentModel } from '../comments/comment.model.js';
import { LikeModel } from '../engagement/engagement.models.js';
import { PostModel } from '../posts/post.model.js';
import { FollowModel } from '../relationships/follow.model.js';
import { isBlockedEitherWay } from '../relationships/relationship.service.js';
import { UserModel } from '../users/user.model.js';
import { NotificationModel } from './notification.model.js';
import {
  dedupeKeyOf,
  notificationEventSchema,
  type NotificationEvent,
} from './notification.queue.js';

const oid = (id: string) => new Types.ObjectId(id);

/** Whether the action behind the notification still stands (it may have been undone meanwhile). */
async function sourceExists(event: NotificationEvent): Promise<boolean> {
  const actor = oid(event.actorId);
  const recipient = oid(event.recipientId);
  switch (event.type) {
    case 'like':
      return (
        event.postId !== undefined &&
        (await LikeModel.exists({ postId: oid(event.postId), userId: actor })) !== null &&
        (await PostModel.exists({ _id: oid(event.postId), deletedAt: null })) !== null
      );
    case 'comment':
    case 'reply':
      return (
        event.commentId !== undefined &&
        (await CommentModel.exists({ _id: oid(event.commentId), deletedAt: null })) !== null
      );
    case 'follow':
      return (
        (await FollowModel.exists({
          followerId: actor,
          followeeId: recipient,
          status: 'active',
        })) !== null
      );
    case 'follow_request':
      return (
        (await FollowModel.exists({
          followerId: actor,
          followeeId: recipient,
          status: 'pending',
        })) !== null
      );
    case 'follow_accept':
      // The recipient followed the actor, and the actor accepted.
      return (
        (await FollowModel.exists({
          followerId: recipient,
          followeeId: actor,
          status: 'active',
        })) !== null
      );
  }
}

export type NotificationOutcome = 'created' | 'duplicate' | 'skipped' | 'retracted';

/**
 * Turns one event into at most one stored notification, then pushes the new unread count.
 *
 * Safe against undo races without locks, by "insert, then check": undo operations delete the source
 * edge first and the notification second, while this inserts the notification first and checks the
 * source second. In every interleaving one side sees the other, so an undone like never leaves a
 * notification behind. Retries are safe: the unique dedupeKey turns a repeated insert into a no-op.
 */
export function createNotificationProcessor({
  realtime,
  logger,
}: {
  realtime: RealtimePublisher;
  logger: Logger;
}) {
  async function process(event: NotificationEvent): Promise<NotificationOutcome> {
    if (event.actorId === event.recipientId) return 'skipped';
    const [recipient, actor, blocked] = await Promise.all([
      UserModel.exists({ _id: oid(event.recipientId), deletedAt: null }),
      UserModel.exists({ _id: oid(event.actorId), deletedAt: null }),
      isBlockedEitherWay(event.actorId, event.recipientId),
    ]);
    if (!recipient || !actor || blocked) return 'skipped';
    // Cheap early exit for the common "already undone" case; the check after insert is the real guard.
    if (!(await sourceExists(event))) return 'skipped';

    const dedupeKey = dedupeKeyOf(event);
    const result = await NotificationModel.updateOne(
      { recipientId: oid(event.recipientId), dedupeKey },
      {
        $setOnInsert: {
          actorId: oid(event.actorId),
          type: event.type,
          postId: event.postId ? oid(event.postId) : null,
          commentId: event.commentId ? oid(event.commentId) : null,
          readAt: null,
        },
      },
      { upsert: true },
    );
    if (result.upsertedCount === 0) return 'duplicate';

    if (!(await sourceExists(event))) {
      await NotificationModel.deleteOne({ recipientId: oid(event.recipientId), dedupeKey });
      return 'retracted';
    }

    const unreadCount = await NotificationModel.countDocuments({
      recipientId: oid(event.recipientId),
      readAt: null,
    });
    realtime.toUser(event.recipientId, 'notification:new', { type: event.type, unreadCount });
    return 'created';
  }

  const handler = async (job: Job): Promise<NotificationOutcome> => {
    const outcome = await process(notificationEventSchema.parse(job.data));
    logger.debug({ jobId: job.id, outcome }, 'Notification processed');
    return outcome;
  };
  return Object.assign(handler, { process });
}
