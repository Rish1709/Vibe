import type { PageMeta } from '@vibe/shared';
import type { z } from 'zod';
import { Errors } from './errors.js';

/**
 * Cursors are opaque to clients: base64url-encoded JSON of the sort key of the last item.
 * They are not signed. A tampered cursor can only ever decode to another value that passes
 * the schema, i.e. a different position in a list the caller is already authorized to read.
 */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<S extends z.ZodType>(cursor: string, schema: S): z.output<S> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw Errors.badRequest('Invalid cursor');
  }
  const result = schema.safeParse(decoded);
  if (!result.success) throw Errors.badRequest('Invalid cursor');
  return result.data;
}

/**
 * Builds a page from rows fetched with `limit + 1`.
 * The extra row tells us whether another page exists without a separate count query,
 * which on large collections would be O(n) per request.
 */
export function toPage<T>(
  rows: T[],
  limit: number,
  cursorOf: (last: T) => unknown,
): { items: T[]; meta: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    meta: { nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null },
  };
}
