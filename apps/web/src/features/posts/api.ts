import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreatePostInput, PostDto, ToggleResultDto } from '@vibe/shared';
import { toast } from 'sonner';
import { apiRequest } from '@/lib/apiClient';
import { fetchPage, pageOptions } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';
import { removePostEverywhere, restorePosts, snapshotPosts, updatePostEverywhere } from './cache';

export function usePost(id: string) {
  return useQuery({
    queryKey: queryKeys.post(id),
    queryFn: async ({ signal }) =>
      (await apiRequest<PostDto>(`/api/v1/posts/${id}`, { signal })).data,
  });
}

export function useUserPosts(userId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.userPosts(userId),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<PostDto>(`/api/v1/users/${userId}/posts`, pageParam, signal),
    ...pageOptions,
    enabled,
  });
}

export function useBookmarks() {
  return useInfiniteQuery({
    queryKey: queryKeys.bookmarks,
    queryFn: ({ pageParam, signal }) =>
      fetchPage<PostDto>('/api/v1/users/me/bookmarks', pageParam, signal),
    ...pageOptions,
  });
}

export function useCreatePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreatePostInput) =>
      (await apiRequest<PostDto>('/api/v1/posts', { method: 'POST', body: input })).data,
    onSuccess: (post) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.userPosts(post.author.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      if (post.sharedPost) {
        updatePostEverywhere(queryClient, post.sharedPost.id, (p) => ({
          ...p,
          counts: { ...p.counts, reposts: p.counts.reposts + 1 },
        }));
      }
    },
  });
}

export function useUpdatePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, text }: { id: string; text: string }) =>
      (await apiRequest<PostDto>(`/api/v1/posts/${id}`, { method: 'PATCH', body: { text } })).data,
    onSuccess: (post) => updatePostEverywhere(queryClient, post.id, () => post),
  });
}

export function useDeletePost() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiRequest(`/api/v1/posts/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      removePostEverywhere(queryClient, id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      toast.success('Post deleted');
    },
  });
}

type ToggleKind = 'like' | 'bookmark' | 'repost';

const TOGGLES: Record<
  ToggleKind,
  { flag: 'liked' | 'bookmarked' | 'reposted'; count?: 'likes' | 'reposts' }
> = {
  like: { flag: 'liked', count: 'likes' },
  bookmark: { flag: 'bookmarked' },
  repost: { flag: 'reposted', count: 'reposts' },
};

/**
 * Optimistic toggles: the UI flips instantly, every cached copy of the post is patched, and the
 * server's authoritative count replaces the guess when it answers. On failure the snapshot is restored.
 * The API is idempotent (PUT/DELETE), so a retried or double-sent toggle cannot double-count.
 */
export function useTogglePost(kind: ToggleKind) {
  const queryClient = useQueryClient();
  const { flag, count } = TOGGLES[kind];

  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      (
        await apiRequest<ToggleResultDto>(`/api/v1/posts/${id}/${kind}`, {
          method: active ? 'PUT' : 'DELETE',
        })
      ).data,
    onMutate: async ({ id, active }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.posts });
      const snapshot = snapshotPosts(queryClient);
      updatePostEverywhere(queryClient, id, (post) => ({
        ...post,
        viewer: { ...post.viewer, [flag]: active },
        counts: count
          ? { ...post.counts, [count]: Math.max(0, post.counts[count] + (active ? 1 : -1)) }
          : post.counts,
      }));
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      if (context) restorePosts(queryClient, context.snapshot);
      toast.error("Couldn't update. Please try again.");
    },
    onSuccess: (result, { id }) => {
      if (count) {
        updatePostEverywhere(queryClient, id, (post) => ({
          ...post,
          counts: { ...post.counts, [count]: result.count },
        }));
      }
      if (kind === 'bookmark')
        void queryClient.invalidateQueries({ queryKey: queryKeys.bookmarks });
    },
  });
}
