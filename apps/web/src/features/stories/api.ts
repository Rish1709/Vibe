import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateStoryInput, StoryDto, StoryGroupDto, UserListItemDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { queryKeys } from '@/lib/queryKeys';

export function useStoryTray() {
  return useQuery({
    queryKey: queryKeys.storyTray,
    queryFn: async ({ signal }) =>
      (await apiRequest<StoryGroupDto[]>('/api/v1/stories/tray', { signal })).data,
    // Stories expire on the server; refetching periodically drops expired rings without a reload.
    refetchInterval: 60_000,
  });
}

export function useCreateStory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateStoryInput) =>
      (await apiRequest<StoryDto>('/api/v1/stories', { method: 'POST', body: input })).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.storyTray }),
  });
}

/**
 * Fire-and-forget view tracking with an optimistic "seen" in the tray cache, so a ring loses its
 * highlight the moment you watch it. The server dedupes repeat views, so retries are harmless.
 */
export function useMarkStoryViewed() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storyId: string) =>
      apiRequest(`/api/v1/stories/${storyId}/views`, { method: 'POST' }),
    onMutate: (storyId) => {
      queryClient.setQueryData<StoryGroupDto[]>(queryKeys.storyTray, (groups) =>
        groups?.map((group) => {
          const stories = group.stories.map((story) =>
            story.id === storyId ? { ...story, viewer: { ...story.viewer, seen: true } } : story,
          );
          return { ...group, stories, hasUnseen: stories.some((story) => !story.viewer.seen) };
        }),
      );
    },
  });
}

export function useStoryViewers(storyId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.storyViewers(storyId),
    queryFn: async ({ signal }) =>
      (await apiRequest<UserListItemDto[]>(`/api/v1/stories/${storyId}/viewers`, { signal })).data,
    enabled,
  });
}

export function useDeleteStory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (storyId: string) => apiRequest(`/api/v1/stories/${storyId}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.storyTray }),
  });
}
