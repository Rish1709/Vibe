import { setTimeout as sleep } from 'node:timers/promises';
import type { Types } from 'mongoose';
import type { Logger } from '../../infra/logger.js';
import { CommentModel } from '../comments/comment.model.js';
import { LikeModel } from '../engagement/engagement.models.js';
import { PostModel } from '../posts/post.model.js';
import { FollowModel } from '../relationships/follow.model.js';
import { UserModel } from '../users/user.model.js';

type Counts = Record<string, number>;
interface Snapshot {
  stored: Map<string, Counts>;
  actual: Map<string, Counts>;
}

const hex = (id: Types.ObjectId) => id.toHexString();
const same = (a: Counts | undefined, b: Counts | undefined) =>
  a !== undefined && b !== undefined && Object.keys(a).every((key) => a[key] === b[key]);

async function countBy(
  pipeline: () => Promise<{ _id: Types.ObjectId; n: number }[]>,
): Promise<Map<string, number>> {
  return new Map((await pipeline()).map((row) => [hex(row._id), row.n]));
}

/** What users.counts should be, recomputed from the edges (the same rules the live $incs follow). */
async function measureUsers(ids: Types.ObjectId[]): Promise<Snapshot> {
  const [users, followers, following, posts] = await Promise.all([
    UserModel.find({ _id: { $in: ids } }, { counts: 1 }).lean(),
    countBy(() =>
      FollowModel.aggregate([
        { $match: { followeeId: { $in: ids }, status: 'active' } },
        { $group: { _id: '$followeeId', n: { $sum: 1 } } },
      ]),
    ),
    countBy(() =>
      FollowModel.aggregate([
        { $match: { followerId: { $in: ids }, status: 'active' } },
        { $group: { _id: '$followerId', n: { $sum: 1 } } },
      ]),
    ),
    // Originals and quotes count as posts; plain reposts don't.
    countBy(() =>
      PostModel.aggregate([
        {
          $match: { authorId: { $in: ids }, kind: { $in: ['original', 'quote'] }, deletedAt: null },
        },
        { $group: { _id: '$authorId', n: { $sum: 1 } } },
      ]),
    ),
  ]);
  const stored = new Map<string, Counts>();
  const actual = new Map<string, Counts>();
  for (const user of users) {
    const id = hex(user._id);
    stored.set(id, { ...user.counts });
    actual.set(id, {
      followers: followers.get(id) ?? 0,
      following: following.get(id) ?? 0,
      posts: posts.get(id) ?? 0,
    });
  }
  return { stored, actual };
}

/** What posts.counts should be. Comments follow the delete rule: a removed thread takes its replies. */
async function measurePosts(ids: Types.ObjectId[]): Promise<Snapshot> {
  const [posts, likes, reposts, topLevel, replyGroups] = await Promise.all([
    PostModel.find({ _id: { $in: ids } }, { counts: 1 }).lean(),
    countBy(() =>
      LikeModel.aggregate([
        { $match: { postId: { $in: ids } } },
        { $group: { _id: '$postId', n: { $sum: 1 } } },
      ]),
    ),
    // Plain reposts (hard-deleted on undo) plus live quotes.
    countBy(() =>
      PostModel.aggregate([
        { $match: { sharedPostId: { $in: ids }, deletedAt: null } },
        { $group: { _id: '$sharedPostId', n: { $sum: 1 } } },
      ]),
    ),
    countBy(() =>
      CommentModel.aggregate([
        { $match: { postId: { $in: ids }, parentId: null, deletedAt: null } },
        { $group: { _id: '$postId', n: { $sum: 1 } } },
      ]),
    ),
    CommentModel.aggregate<{ _id: { post: Types.ObjectId; parent: Types.ObjectId }; n: number }>([
      { $match: { postId: { $in: ids }, parentId: { $ne: null }, deletedAt: null } },
      { $group: { _id: { post: '$postId', parent: '$parentId' }, n: { $sum: 1 } } },
    ]),
  ]);
  // Replies count only while their thread's top-level comment is alive.
  const liveParents = new Set(
    (
      await CommentModel.find(
        { _id: { $in: replyGroups.map((group) => group._id.parent) }, deletedAt: null },
        { _id: 1 },
      ).lean()
    ).map((row) => hex(row._id)),
  );
  const comments = new Map(topLevel);
  for (const group of replyGroups) {
    if (!liveParents.has(hex(group._id.parent))) continue;
    const post = hex(group._id.post);
    comments.set(post, (comments.get(post) ?? 0) + group.n);
  }

  const stored = new Map<string, Counts>();
  const actual = new Map<string, Counts>();
  for (const post of posts) {
    const id = hex(post._id);
    stored.set(id, { ...post.counts });
    actual.set(id, {
      likes: likes.get(id) ?? 0,
      comments: comments.get(id) ?? 0,
      reposts: reposts.get(id) ?? 0,
    });
  }
  return { stored, actual };
}

export interface ReconcileResult {
  checked: number;
  drifted: number;
  fixed: number;
}

/**
 * Daily safety net for the denormalized counters. They are maintained by $inc on the operation that
 * changed an edge, which is exact unless a process dies between the edge write and the $inc.
 *
 * The hazard of any reconciler: an edge write and its $inc are two steps, so a counter read between
 * them looks wrong but is about to be right. "Fixing" it would introduce the very drift we're
 * removing. So each batch is measured twice, `settleMs` apart, and only counters that are *quiet*
 * (stored and actual both unchanged) and still wrong are corrected, with a write that is conditional
 * on the stored value not having moved. Busy counters are skipped and caught on a later run.
 */
export function createCounterReconciler({
  logger,
  settleMs = 2_000,
  batchSize = 200,
  settle = () => sleep(settleMs),
}: {
  logger: Logger;
  settleMs?: number;
  batchSize?: number;
  /** The pause between the two measurements (tests inject activity here). */
  settle?: () => Promise<unknown>;
}) {
  async function sweep(
    nextBatch: (after: Types.ObjectId | null) => Promise<Types.ObjectId[]>,
    measure: (ids: Types.ObjectId[]) => Promise<Snapshot>,
    write: (id: string, from: Counts, to: Counts) => Promise<boolean>,
  ): Promise<ReconcileResult> {
    const result: ReconcileResult = { checked: 0, drifted: 0, fixed: 0 };
    let after: Types.ObjectId | null = null;
    for (;;) {
      const ids = await nextBatch(after);
      if (ids.length === 0) return result;
      after = ids[ids.length - 1] ?? null;
      result.checked += ids.length;

      const first = await measure(ids);
      const suspects = ids.filter((id) => {
        const key = hex(id);
        return !same(first.stored.get(key), first.actual.get(key));
      });
      if (suspects.length > 0) {
        await settle();
        const second = await measure(suspects);
        for (const id of suspects) {
          const key = hex(id);
          const quiet =
            same(first.stored.get(key), second.stored.get(key)) &&
            same(first.actual.get(key), second.actual.get(key));
          const from = second.stored.get(key);
          const to = second.actual.get(key);
          if (!quiet || !from || !to || same(from, to)) continue;
          result.drifted += 1;
          if (await write(key, from, to)) result.fixed += 1;
        }
      }
      if (ids.length < batchSize) return result;
    }
  }

  /** Conditional on every stored counter still holding the value we measured. */
  const conditionalSet = (prefix: string, from: Counts, to: Counts) => ({
    filter: Object.fromEntries(
      Object.entries(from).map(([key, value]) => [`${prefix}.${key}`, value]),
    ),
    update: {
      $set: Object.fromEntries(
        Object.entries(to).map(([key, value]) => [`${prefix}.${key}`, value]),
      ),
    },
  });

  return async function reconcile(): Promise<{ users: ReconcileResult; posts: ReconcileResult }> {
    const users = await sweep(
      async (after) =>
        (
          await UserModel.find(
            { deletedAt: null, ...(after && { _id: { $gt: after } }) },
            { _id: 1 },
          )
            .sort({ _id: 1 })
            .limit(batchSize)
            .lean()
        ).map((row) => row._id),
      measureUsers,
      async (id, from, to) => {
        const { filter, update } = conditionalSet('counts', from, to);
        const res = await UserModel.updateOne({ _id: id, ...filter }, update);
        return res.modifiedCount === 1;
      },
    );
    const posts = await sweep(
      async (after) =>
        (
          await PostModel.find(
            {
              deletedAt: null,
              kind: { $in: ['original', 'quote'] },
              ...(after && { _id: { $gt: after } }),
            },
            { _id: 1 },
          )
            .sort({ _id: 1 })
            .limit(batchSize)
            .lean()
        ).map((row) => row._id),
      measurePosts,
      async (id, from, to) => {
        const { filter, update } = conditionalSet('counts', from, to);
        const res = await PostModel.updateOne({ _id: id, ...filter }, update);
        return res.modifiedCount === 1;
      },
    );
    logger.info({ users, posts }, 'Counter reconciliation finished');
    return { users, posts };
  };
}
