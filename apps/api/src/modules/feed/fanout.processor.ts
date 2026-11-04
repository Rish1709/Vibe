import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { FeedConfig } from '../../config/feed.js';
import type { Logger } from '../../infra/logger.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { FollowModel } from '../relationships/follow.model.js';
import { fanoutJobSchema } from './feed.queue.js';
import type { TimelineStore } from './timeline.store.js';

/**
 * Pushes (or removes) one post into every active follower's timeline.
 *
 * Followers are paged with the same keyset cursor as API lists, over the
 * { followeeId, status, createdAt, _id } index, so a 9,999-follower author costs ~20 indexed batches and
 * one Redis pipeline each, never a full in-memory sort.
 *
 * Idempotent, so BullMQ retries are safe: ZADD of the same (score, member) is a no-op and ZREM of a
 * missing member is too. A retry simply re-walks the follower list from the start.
 * Only followers whose timeline already exists are written (inside the Lua script): inactive users'
 * timelines have expired and will be rebuilt from MongoDB if they return, so we don't spend memory on
 * people who aren't reading.
 */
export function createFanoutProcessor({
  timeline,
  logger,
}: {
  timeline: TimelineStore;
  logger: Logger;
}) {
  return async (job: Job): Promise<{ followers: number; written: number }> => {
    const { action, postId, authorId, t } = fanoutJobSchema.parse(job.data);
    let cursor: string | undefined;
    let followers = 0;
    let written = 0;

    do {
      const rows = await FollowModel.find({
        followeeId: new Types.ObjectId(authorId),
        status: 'active',
        ...keysetFilter(cursor, 'asc'),
      })
        .sort(keysetSort('asc'))
        .limit(FeedConfig.fanoutBatchSize + 1)
        .lean();
      const { items, meta } = keysetPage(rows, FeedConfig.fanoutBatchSize);
      const ids = items.map((row) => row.followerId.toHexString());
      followers += ids.length;
      if (action === 'publish') {
        written += await timeline.addToExisting(ids, { id: postId, t });
      } else {
        await timeline.removeFromAll(ids, postId);
      }
      cursor = meta.nextCursor ?? undefined;
    } while (cursor);

    logger.debug({ action, postId, followers, written }, 'Fan-out complete');
    return { followers, written };
  };
}
