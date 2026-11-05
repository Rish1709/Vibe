import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  FollowRequestDto,
  FollowResultDto,
  FollowState,
  ProfileDto,
  UserListItemDto,
  UserSummaryDto,
} from '@vibe/shared';
import { toast } from 'sonner';
import { apiRequest } from '@/lib/apiClient';
import { fetchPage, pageOptions } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';

export const useFollowers = (userId: string) =>
  useInfiniteQuery({
    queryKey: queryKeys.followers(userId),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<UserListItemDto>(`/api/v1/users/${userId}/followers`, pageParam, signal),
    ...pageOptions,
  });

export const useFollowing = (userId: string) =>
  useInfiniteQuery({
    queryKey: queryKeys.following(userId),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<UserListItemDto>(`/api/v1/users/${userId}/following`, pageParam, signal),
    ...pageOptions,
  });

export const useFollowRequests = () =>
  useInfiniteQuery({
    queryKey: queryKeys.followRequests,
    queryFn: ({ pageParam, signal }) =>
      fetchPage<FollowRequestDto>('/api/v1/users/me/follow-requests', pageParam, signal),
    ...pageOptions,
  });

export const useBlockedUsers = () =>
  useInfiniteQuery({
    queryKey: queryKeys.blocks,
    queryFn: ({ pageParam, signal }) =>
      fetchPage<UserSummaryDto>('/api/v1/users/me/blocks', pageParam, signal),
    ...pageOptions,
  });

/**
 * Follow/unfollow with an optimistic profile update. A public account flips to "Following" and the
 * follower count moves at once; a private one shows "Requested" and the count stays (nothing is
 * granted until approval). The server's answer is authoritative and replaces the guess.
 */
export function useFollow(profile: ProfileDto) {
  const queryClient = useQueryClient();
  const key = queryKeys.profile(profile.username);

  return useMutation({
    mutationFn: async (follow: boolean) =>
      (
        await apiRequest<FollowResultDto>(`/api/v1/users/${profile.id}/follow`, {
          method: follow ? 'PUT' : 'DELETE',
        })
      ).data,
    onMutate: async (follow) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<ProfileDto>(key);
      if (previous?.viewer) {
        const next: FollowState = follow ? (previous.isPrivate ? 'pending' : 'active') : 'none';
        const delta =
          (next === 'active' ? 1 : 0) - (previous.viewer.following === 'active' ? 1 : 0);
        queryClient.setQueryData<ProfileDto>(key, {
          ...previous,
          viewer: { ...previous.viewer, following: next },
          counts: { ...previous.counts, followers: Math.max(0, previous.counts.followers + delta) },
          canViewContent: previous.isPrivate ? next === 'active' : previous.canViewContent,
        });
      }
      return { previous };
    },
    onError: (_err, _follow, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      toast.error('Something went wrong. Please try again.');
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      void queryClient.invalidateQueries({ queryKey: queryKeys.followers(profile.id) });
    },
  });
}

/** Follow toggles inside user lists: not optimistic (we don't know if the account is private). */
export function useFollowUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, follow }: { userId: string; follow: boolean }) =>
      (
        await apiRequest<FollowResultDto>(`/api/v1/users/${userId}/follow`, {
          method: follow ? 'PUT' : 'DELETE',
        })
      ).data,
    onSuccess: () => {
      for (const prefix of ['followers', 'following', 'likers', 'profile', 'search', 'explore']) {
        void queryClient.invalidateQueries({ queryKey: [prefix] });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: () => toast.error('Something went wrong. Please try again.'),
  });
}

export function useBlock(profile: { id: string; username: string }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (block: boolean) =>
      apiRequest(`/api/v1/users/${profile.id}/block`, { method: block ? 'PUT' : 'DELETE' }),
    onSuccess: (_data, block) => {
      toast.success(block ? `Blocked @${profile.username}` : `Unblocked @${profile.username}`);
      // Drop their cached posts first: refetching them against the pre-block profile would 403.
      // They are requested again only if the refreshed profile says the viewer may see them.
      queryClient.removeQueries({ queryKey: queryKeys.userPosts(profile.id) });
      // A block removes follows both ways and hides content everywhere, so refetch broadly.
      void queryClient.invalidateQueries();
    },
    onError: () => toast.error('Something went wrong. Please try again.'),
  });
}

export function useRespondToRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, accept }: { requestId: string; accept: boolean }) =>
      accept
        ? apiRequest(`/api/v1/users/me/follow-requests/${requestId}/accept`, { method: 'POST' })
        : apiRequest(`/api/v1/users/me/follow-requests/${requestId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.followRequests });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: () => toast.error('Something went wrong. Please try again.'),
  });
}
