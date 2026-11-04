import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { UserSearchResultDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { queryKeys } from '@/lib/queryKeys';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

const SEARCH_DEBOUNCE_MS = 250;

/**
 * Search-as-you-type: one request per pause in typing, not per keystroke. The previous results stay
 * on screen while the next ones load, so the list doesn't flash empty between keystrokes.
 */
export function useUserSearch(typed: string) {
  const q = useDebouncedValue(typed.trim(), SEARCH_DEBOUNCE_MS);
  const query = useQuery({
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
  return { ...query, debouncedQuery: q };
}
