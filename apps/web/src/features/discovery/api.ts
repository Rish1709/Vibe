import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { PostDto, SuggestedUserDto, TrendingHashtagDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { fetchPage, pageOptions } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';

export const usePostSearch = (q: string) =>
  useInfiniteQuery({
    queryKey: queryKeys.postSearch(q),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<PostDto>(`/api/v1/search/posts?q=${encodeURIComponent(q)}`, pageParam, signal),
    ...pageOptions,
    enabled: q.length > 0,
  });

export const useHashtagPosts = (tag: string) =>
  useInfiniteQuery({
    queryKey: queryKeys.hashtagPosts(tag),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<PostDto>(`/api/v1/hashtags/${encodeURIComponent(tag)}/posts`, pageParam, signal),
    ...pageOptions,
  });

export const useTrending = () =>
  useQuery({
    queryKey: queryKeys.trending,
    queryFn: async ({ signal }) =>
      (await apiRequest<TrendingHashtagDto[]>('/api/v1/explore/trending', { signal })).data,
    staleTime: 5 * 60_000,
  });

export const useSuggestions = (limit = 5) =>
  useQuery({
    queryKey: [...queryKeys.suggestions, limit],
    queryFn: async ({ signal }) =>
      (
        await apiRequest<SuggestedUserDto[]>(`/api/v1/explore/suggestions?limit=${limit}`, {
          signal,
        })
      ).data,
  });
