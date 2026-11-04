import { Types } from 'mongoose';
import { PostModel } from '../posts/post.model.js';
import type { FeedCursor, FeedEntry } from './feed.types.js';

/**
 * Fan-out-on-read: the newest posts by any of `authorIds`, after `cursor`.
 *
 * With the { authorId, createdAt, _id } index, MongoDB answers `authorId: { $in }` plus the sort with a
 * SORT_MERGE: one index range per author, merged by the sort key, stopping after `limit` entries. No
 * in-memory sort of every candidate post. Cost grows with the number of authors (one seek per range),
 * which is why large followings are served from precomputed timelines instead.
 */
export async function pullEntries(
  authorIds: string[],
  cursor: FeedCursor | null,
  limit: number,
  { onlyFanoutSkipped = false }: { onlyFanoutSkipped?: boolean } = {},
): Promise<FeedEntry[]> {
  if (authorIds.length === 0 || limit <= 0) return [];
  const after = cursor
    ? {
        $or: [
          { createdAt: { $lt: new Date(cursor.t) } },
          { createdAt: new Date(cursor.t), _id: { $lt: new Types.ObjectId(cursor.id) } },
        ],
      }
    : {};
  const rows = await PostModel.find(
    {
      // Equality on the partial index's filter field lets the planner use that small index.
      ...(onlyFanoutSkipped && { fanoutSkipped: true }),
      authorId: { $in: authorIds.map((id) => new Types.ObjectId(id)) },
      deletedAt: null,
      ...after,
    },
    { _id: 1, createdAt: 1 },
  )
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .lean<{ _id: Types.ObjectId; createdAt: Date }[]>();
  return rows.map((row) => ({ id: row._id.toHexString(), t: row.createdAt.getTime() }));
}

export type PullSource = typeof pullEntries;
