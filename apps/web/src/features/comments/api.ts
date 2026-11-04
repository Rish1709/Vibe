import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CommentDto, CreateCommentInput, PostDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { fetchPage, pageOptions } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';
import { updatePostEverywhere } from '../posts/cache';

export function useComments(postId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.comments(postId),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<CommentDto>(`/api/v1/posts/${postId}/comments`, pageParam, signal),
    ...pageOptions,
  });
}

export function useReplies(commentId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.replies(commentId),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<CommentDto>(`/api/v1/comments/${commentId}/replies`, pageParam, signal),
    ...pageOptions,
    enabled,
  });
}

const bumpComments =
  (delta: number) =>
  (post: PostDto): PostDto => ({
    ...post,
    counts: { ...post.counts, comments: Math.max(0, post.counts.comments + delta) },
  });

export function useCreateComment(postId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCommentInput) =>
      (
        await apiRequest<CommentDto>(`/api/v1/posts/${postId}/comments`, {
          method: 'POST',
          body: input,
        })
      ).data,
    onSuccess: (comment) => {
      updatePostEverywhere(queryClient, postId, bumpComments(1));
      if (comment.parentId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.replies(comment.parentId) });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.comments(postId) });
    },
  });
}

export function useDeleteComment(postId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (comment: CommentDto) =>
      apiRequest(`/api/v1/comments/${comment.id}`, { method: 'DELETE' }),
    onSuccess: (_data, comment) => {
      const removed = 1 + (comment.parentId ? 0 : comment.counts.replies);
      updatePostEverywhere(queryClient, postId, bumpComments(-removed));
      void queryClient.invalidateQueries({ queryKey: queryKeys.comments(postId) });
      if (comment.parentId)
        void queryClient.invalidateQueries({ queryKey: queryKeys.replies(comment.parentId) });
    },
  });
}
