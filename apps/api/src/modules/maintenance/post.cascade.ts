import { Types } from 'mongoose';
import type { Logger } from '../../infra/logger.js';
import { CommentModel } from '../comments/comment.model.js';
import { BookmarkModel, LikeModel } from '../engagement/engagement.models.js';
import { NotificationModel } from '../notifications/notification.model.js';
import { PostModel } from '../posts/post.model.js';

const BATCH = 1_000;

/**
 * Deletes in bounded batches of ids rather than one deleteMany over a whole viral post's likes, so no
 * single operation holds locks or replication for long, and progress survives a crash.
 */
async function deleteInBatches(
  findIds: () => Promise<{ _id: Types.ObjectId }[]>,
  deleteIds: (ids: Types.ObjectId[]) => Promise<{ deletedCount: number }>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = (await findIds()).map((row) => row._id);
    if (ids.length === 0) return total;
    total += (await deleteIds(ids)).deletedCount;
    if (ids.length < BATCH) return total;
  }
}

/**
 * Removes everything that hangs off a deleted post. Deleting the post is instant for the user (a soft
 * delete; reads already hide its likes and comments), and this tidies up afterwards.
 *
 * Idempotent: a retry deletes whatever is left. It refuses to touch a post that isn't deleted, so a
 * stray job can never wipe a live post's engagement.
 */
export function createPostCascade({ logger }: { logger: Logger }) {
  return async function cascade(postId: string) {
    const _id = new Types.ObjectId(postId);
    const post = await PostModel.findById(_id, { deletedAt: 1 }).lean();
    if (post && post.deletedAt === null) {
      logger.warn({ postId }, 'Cascade skipped: post is not deleted');
      return { skipped: true as const };
    }
    const byPost = { postId: _id };
    const [likes, bookmarks, comments, notifications] = await Promise.all([
      deleteInBatches(
        () => LikeModel.find(byPost, { _id: 1 }).limit(BATCH).lean(),
        (ids) => LikeModel.deleteMany({ _id: { $in: ids } }),
      ),
      deleteInBatches(
        () => BookmarkModel.find(byPost, { _id: 1 }).limit(BATCH).lean(),
        (ids) => BookmarkModel.deleteMany({ _id: { $in: ids } }),
      ),
      deleteInBatches(
        () => CommentModel.find(byPost, { _id: 1 }).limit(BATCH).lean(),
        (ids) => CommentModel.deleteMany({ _id: { $in: ids } }),
      ),
      deleteInBatches(
        () => NotificationModel.find(byPost, { _id: 1 }).limit(BATCH).lean(),
        (ids) => NotificationModel.deleteMany({ _id: { $in: ids } }),
      ),
    ]);
    const removed = { likes, bookmarks, comments, notifications };
    logger.info({ postId, removed }, 'Post cascade finished');
    return { skipped: false as const, removed };
  };
}
