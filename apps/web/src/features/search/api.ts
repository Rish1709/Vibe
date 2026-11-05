import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { UserSearchResultDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { queryKeys } from '@/lib/queryKeys';

/** How long typing must pause before a search is sent. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * People search for an already-debounced query (the search page debounces once, for both tabs).
 * Previous results stay on screen while the next ones load, so the list doesn't flash empty.
 */
export function useUserSearch(q: string) {
  return useQuery({
    queryKey: queryKeys.userSearch(q),
    queryFn: async ({ signal }) =>
      (
        await apiRequest<UserSearchResultDto[]>(`/api/v1/search/users?q=${encodeURIComponent(q)}`, {
          signal,
        })
      ).data,
    enabled: q.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
