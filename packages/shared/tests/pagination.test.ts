import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  objectIdSchema,
  paginationQuerySchema,
} from '../src/index.js';

describe('paginationQuerySchema', () => {
  it('applies the default limit', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE });
  });

  it('coerces query-string numbers', () => {
    expect(paginationQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    });
  });

  it.each([['0'], [String(MAX_PAGE_SIZE + 1)], ['1.5'], ['abc']])('rejects limit=%s', (limit) => {
    expect(paginationQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('rejects oversized cursors', () => {
    expect(paginationQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });
});

describe('objectIdSchema', () => {
  it('accepts 24-char hex ids', () => {
    expect(objectIdSchema.safeParse('65a1b2c3d4e5f60718293a4b').success).toBe(true);
  });

  it.each([['123'], ['zzzzzzzzzzzzzzzzzzzzzzzz'], [{ $ne: null }]])('rejects %j', (value) => {
    expect(objectIdSchema.safeParse(value).success).toBe(false);
  });
});
