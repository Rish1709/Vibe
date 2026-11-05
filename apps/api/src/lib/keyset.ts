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
 * Requires an index ending in `{ <field>: ±1, _id: ±1 }` after the equality fields. The field defaults
 * to `createdAt`; the inbox pages on `lastMessageAt`.
 */
const keysetCursorSchema = z.object({
  t: z.iso.datetime(),
  id: z.string().regex(/^[a-f\d]{24}$/i),
});

type Direction = 'desc' | 'asc';

export function keysetFilter(
  cursor: string | undefined,
  direction: Direction,
  field: string = 'createdAt',
) {
  if (!cursor) return {};
  const { t, id } = decodeCursor(cursor, keysetCursorSchema);
  const op = direction === 'desc' ? '$lt' : '$gt';
  const at = new Date(t);
  return {
    $or: [{ [field]: { [op]: at } }, { [field]: at, _id: { [op]: new Types.ObjectId(id) } }],
  };
}

export function keysetSort(direction: Direction, field: string = 'createdAt') {
  const order = direction === 'desc' ? -1 : 1;
  return { [field]: order, _id: order } as Record<string, 1 | -1>;
}

/** Wraps toPage with the cursor shape keysetFilter understands. Fetch `limit + 1` rows first. */
export function keysetPage<T extends { _id: Types.ObjectId; createdAt: Date }>(
  rows: T[],
  limit: number,
): ReturnType<typeof toPage<T>>;
export function keysetPage<T extends { _id: Types.ObjectId }>(
  rows: T[],
  limit: number,
  at: (row: T) => Date,
): ReturnType<typeof toPage<T>>;
export function keysetPage<T extends { _id: Types.ObjectId }>(
  rows: T[],
  limit: number,
  at: (row: T) => Date = (row) => (row as unknown as { createdAt: Date }).createdAt,
) {
  return toPage(rows, limit, (last) => ({
    t: at(last).toISOString(),
    id: last._id.toHexString(),
  }));
}
