import type { UserSummaryDto } from '@vibe/shared';
import mongoose, { Types, type ClientSession } from 'mongoose';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import { keysetFilter, keysetPage, keysetSort } from '../../lib/keyset.js';
import { adjustFollowCounts, findUserSummaries, requireActiveUser } from '../users/user.queries.js';
import type { AuthUser } from '../users/user.service.js';
import type { FeedWriter } from '../feed/feed.writer.js';
import { BlockModel, type BlockRecord } from './block.model.js';
import { FollowModel } from './follow.model.js';

export type BlockService = ReturnType<typeof createBlockService>;

/**
 * Deletes follow edges (and pending requests) in both directions. Only the call that actually deletes
 * an active edge decrements the counters, so overlapping calls never double-count.
 */
async function removeEdgesBetween(a: Types.ObjectId, b: Types.ObjectId, session?: ClientSession) {
  for (const [followerId, followeeId] of [
    [a, b],
    [b, a],
  ] as const) {
    const removed = await FollowModel.findOneAndDelete(
      { followerId, followeeId },
      { projection: { status: 1 }, ...(session && { session }) },
    ).lean();
    if (removed?.status === 'active') {
      await adjustFollowCounts(followerId, followeeId, -1, session);
    }
  }
}

export function createBlockService({ feed }: { feed: FeedWriter }) {
  return {
    /**
     * A transaction, because blocking must be all-or-nothing: the block row, removal of follow edges in
     * both directions (including pending requests), and the matching counter decrements. A crash
     * half-way would otherwise leave someone following a person who blocked them.
     *
     * The transaction alone is not enough against a concurrent follow. Under snapshot isolation the
     * block row stays invisible until commit, and the transaction's edge delete reads its snapshot, so
     * an edge inserted mid-transaction is missed by the delete while the follow's own block check
     * still sees no block. The post-commit sweep closes that window: a follow either checks after the
     * commit (sees the block and removes its edge) or inserted its edge before the commit (so the
     * sweep, which reads the latest data, removes it). Found by the concurrent follow/block test.
     *
     * Idempotent: blocking twice is a no-op.
     */
    async block(viewer: AuthUser, targetId: string): Promise<void> {
      if (targetId === viewer.id) throw Errors.badRequest("You can't block yourself");
      await requireActiveUser(targetId);
      const [me, them] = [new Types.ObjectId(viewer.id), new Types.ObjectId(targetId)];

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (await BlockModel.exists({ blockerId: me, blockedId: them }).session(session)) return;
          await BlockModel.create([{ blockerId: me, blockedId: them }], { session });
          await removeEdgesBetween(me, them, session);
        });
      } catch (err) {
        // Two concurrent blocks: the loser's insert hits the unique index. The block exists either way.
        if (!isDuplicateKeyError(err)) throw err;
      } finally {
        await session.endSession();
      }

      await removeEdgesBetween(me, them);
      // Neither side may see the other in their feed from now on.
      await feed.onGraphChanged([viewer.id, targetId]);
    },

    /** Unblocking does not restore previous follows; either side must follow again. */
    async unblock(viewer: AuthUser, targetId: string): Promise<void> {
      await BlockModel.deleteOne({ blockerId: viewer.id, blockedId: targetId });
    },

    async listBlocked(
      viewer: AuthUser,
      { cursor, limit }: { cursor?: string | undefined; limit: number },
    ) {
      const rows = await BlockModel.find({
        blockerId: new Types.ObjectId(viewer.id),
        ...keysetFilter(cursor, 'desc'),
      })
        .sort(keysetSort('desc'))
        .limit(limit + 1)
        .lean<BlockRecord[]>();
      const { items: blocks, meta } = keysetPage(rows, limit);
      const summaries = await findUserSummaries(
        blocks.map((block) => block.blockedId.toHexString()),
      );
      const items: UserSummaryDto[] = blocks.flatMap((block) => {
        const summary = summaries.get(block.blockedId.toHexString());
        return summary ? [summary] : [];
      });
      return { items, meta };
    },
  };
}
