import type { ApiSuccess } from '@vibe/shared';
import { apiRequest } from './apiClient';

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Fetches one cursor page; used as the queryFn of every infinite list. */
export async function fetchPage<T>(
  path: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<Page<T>> {
  const separator = path.includes('?') ? '&' : '?';
  const url = cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path;
  const res: ApiSuccess<T[]> = await apiRequest<T[]>(url, { signal });
  return { items: res.data, nextCursor: res.meta?.nextCursor ?? null };
}

export const pageOptions = {
  initialPageParam: null as string | null,
  getNextPageParam: (last: Page<unknown>) => last.nextCursor,
};
