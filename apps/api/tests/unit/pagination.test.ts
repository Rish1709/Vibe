import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../src/lib/errors.js';
import { decodeCursor, encodeCursor, toPage } from '../../src/lib/pagination.js';

const cursorSchema = z.object({ createdAt: z.iso.datetime(), id: z.string().length(24) });

describe('cursor encoding', () => {
  it('round-trips a sort key', () => {
    const key = { createdAt: '2026-11-03T10:00:00.000Z', id: '65a1b2c3d4e5f60718293a4b' };
    expect(decodeCursor(encodeCursor(key), cursorSchema)).toEqual(key);
  });

  it('produces URL-safe output', () => {
    expect(encodeCursor({ v: '???>>>~~~' })).toMatch(/^[\w-]+$/);
  });

  it.each([
    ['garbage', 'not base64 json'],
    ['wrong shape', encodeCursor({ createdAt: 'yesterday', id: 1 })],
    ['operator injection', encodeCursor({ createdAt: { $gt: '' }, id: { $ne: null } })],
  ])('rejects a %s cursor with 400', (_label, cursor) => {
    try {
      decodeCursor(cursor, cursorSchema);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
    }
  });
});

describe('toPage', () => {
  const rows = [1, 2, 3, 4];

  it('trims the sentinel row and emits a cursor when more rows exist', () => {
    const page = toPage(rows, 3, (n) => ({ n }));
    expect(page.items).toEqual([1, 2, 3]);
    expect(decodeCursor(page.meta.nextCursor ?? '', z.object({ n: z.number() }))).toEqual({ n: 3 });
  });

  it('returns a null cursor on the last page', () => {
    expect(toPage(rows, 4, (n) => n).meta.nextCursor).toBeNull();
    expect(toPage([], 10, (n) => n)).toEqual({ items: [], meta: { nextCursor: null } });
  });
});
