import { useQuery } from '@tanstack/react-query';
import type { ProfileDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { queryKeys } from '@/lib/queryKeys';

export function useProfile(username: string) {
  return useQuery({
    queryKey: queryKeys.profile(username),
    queryFn: async ({ signal }) =>
      (await apiRequest<ProfileDto>(`/api/v1/users/${encodeURIComponent(username)}`, { signal }))
        .data,
    enabled: username.length > 0,
  });
}
