import { Types } from 'mongoose';
import { z } from 'zod';
import { decodeCursor, toPage } from './pagination.js';

/**
 * Keyset ("seek") pagination on (createdAt, _id).
 *
 * `createdAt` alone is not unique (two documents can share a millisecond), so `_id` breaks ties.
 * The filter `createdAt < t OR (createdAt = t AND _id < id)` resumes exactly after the last item
 * using an index range scan: O(log n + page) per page at any depth, versus O(skip) for offsets,
 * and stable while new items are inserted at the head.
 *
 * Requires an index ending in `{ createdAt: ±1, _id: ±1 }` after the equality fields.
 */
const keysetCursorSchema = z.object({
  t: z.iso.datetime(),
  id: z.string().regex(/^[a-f\d]{24}$/i),
});

type Direction = 'desc' | 'asc';

export function keysetFilter(cursor: string | undefined, direction: Direction) {
  if (!cursor) return {};
  const { t, id } = decodeCursor(cursor, keysetCursorSchema);
  const op = direction === 'desc' ? '$lt' : '$gt';
  const createdAt = new Date(t);
  return {
    $or: [{ createdAt: { [op]: createdAt } }, { createdAt, _id: { [op]: new Types.ObjectId(id) } }],
  };
}

export function keysetSort(direction: Direction) {
  const order = direction === 'desc' ? -1 : 1;
  return { createdAt: order, _id: order } as const;
}

/** Wraps toPage with the cursor shape keysetFilter understands. Fetch `limit + 1` rows first. */
export function keysetPage<T extends { _id: Types.ObjectId; createdAt: Date }>(
  rows: T[],
  limit: number,
) {
  return toPage(rows, limit, (last) => ({
    t: last.createdAt.toISOString(),
    id: last._id.toHexString(),
  }));
}
