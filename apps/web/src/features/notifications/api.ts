import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationDto, UnreadCountsDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { fetchPage, pageOptions } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';

export const useNotifications = () =>
  useInfiniteQuery({
    queryKey: queryKeys.notifications,
    queryFn: ({ pageParam, signal }) =>
      fetchPage<NotificationDto>('/api/v1/notifications', pageParam, signal),
    ...pageOptions,
  });

/**
 * Clears the badge at once. The list keeps showing which items were new for this visit: their
 * `read` flags are left as loaded until the next refetch.
 */
export function useMarkAllRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/v1/notifications/read', { method: 'POST' }),
    onMutate: () => {
      queryClient.setQueryData<UnreadCountsDto>(queryKeys.unreadCounts, (counts) =>
        counts ? { ...counts, notifications: 0 } : counts,
      );
    },
  });
}
