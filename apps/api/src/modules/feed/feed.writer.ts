import type { Types } from 'mongoose';
import type { Logger } from '../../infra/logger.js';
import { UserModel } from '../users/user.model.js';
import type { FeedQueue } from './feed.queue.js';
import type { TimelineStore } from './timeline.store.js';

interface PublishedPost {
  _id: Types.ObjectId;
  authorId: Types.ObjectId;
  createdAt: Date;
  fanoutSkipped?: boolean | null | undefined;
}

interface FeedWriterDeps {
  timeline: TimelineStore;
  queue: FeedQueue;
  celebrityThreshold: number;
  logger: Logger;
}

export type FeedWriter = ReturnType<typeof createFeedWriter>;

/**
 * Keeps timelines in step with writes. Feed maintenance is never allowed to fail the user's request:
 * the post or follow is already committed in MongoDB, and a missed timeline update only makes a cache
 * stale (the next rebuild repairs it), so errors are logged, not thrown.
 */
export function createFeedWriter({ timeline, queue, celebrityThreshold, logger }: FeedWriterDeps) {
  const entryOf = (post: PublishedPost) => ({
    id: post._id.toHexString(),
    t: post.createdAt.getTime(),
  });

  async function guarded(what: string, work: () => Promise<unknown>) {
    try {
      await work();
    } catch (err) {
      logger.error({ err }, `Feed update failed: ${what}`);
    }
  }

  return {
    /**
     * Decided before the post is saved, and stored on it (see PostRecord.fanoutSkipped). If the lookup
     * fails we fan out: a wasted fan-out costs work, a wrongly skipped one would hide the post.
     */
    async shouldSkipFanout(authorId: string): Promise<boolean> {
      try {
        const author = await UserModel.findById(authorId, { 'counts.followers': 1 }).lean();
        return (author?.counts.followers ?? 0) >= celebrityThreshold;
      } catch (err) {
        logger.warn({ err }, 'Celebrity check failed; fanning out');
        return false;
      }
    },

    /**
     * Read-your-writes: the author's own timeline gets the post synchronously (one Redis call), so it
     * shows at the top of their feed immediately. Followers get it asynchronously via the fan-out job,
     * unless the post was flagged fanoutSkipped (celebrity author), in which case readers pull it.
     */
    async onPostPublished(post: PublishedPost): Promise<void> {
      const authorId = post.authorId.toHexString();
      await guarded('own timeline', () => timeline.addToExisting([authorId], entryOf(post)));
      if (post.fanoutSkipped) return;
      await guarded('enqueue fan-out', () =>
        queue.enqueue({
          action: 'publish',
          postId: entryOf(post).id,
          authorId,
          t: entryOf(post).t,
        }),
      );
    },

    /**
     * Removal from followers' timelines is cleanup, not correctness: hydration already drops deleted
     * posts. It just frees the slots.
     */
    async onPostRemoved(post: PublishedPost): Promise<void> {
      const authorId = post.authorId.toHexString();
      await guarded('own timeline removal', () =>
        timeline.removeFromAll([authorId], entryOf(post).id),
      );
      await guarded('enqueue removal', () =>
        queue.enqueue({ action: 'remove', postId: entryOf(post).id, authorId, t: entryOf(post).t }),
      );
    },

    /** Follow, unfollow, accept, remove-follower, block: the affected users' timelines are rebuilt lazily. */
    async onGraphChanged(userIds: string[]): Promise<void> {
      await guarded('invalidate timelines', () => timeline.invalidate(userIds));
    },
  };
}
