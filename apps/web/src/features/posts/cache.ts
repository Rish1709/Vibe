import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { PostDto } from '@vibe/shared';
import type { Page } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';

type PostCacheEntry = PostDto | InfiniteData<Page<PostDto>> | undefined;

function patchPost(post: PostDto, id: string, update: (post: PostDto) => PostDto): PostDto {
  const self = post.id === id ? update(post) : post;
  if (self.sharedPost?.id === id) return { ...self, sharedPost: update(self.sharedPost) };
  return self;
}

function isInfinite(entry: PostCacheEntry): entry is InfiniteData<Page<PostDto>> {
  return typeof entry === 'object' && 'pages' in entry;
}

/**
 * Applies `update` to post `id` in every cached query under ['posts'], including copies nested as a
 * repost's or quote's shared post. Keeps a like on the feed and the detail page in sync without refetching.
 */
export function updatePostEverywhere(
  queryClient: QueryClient,
  id: string,
  update: (post: PostDto) => PostDto,
): void {
  queryClient.setQueriesData<PostCacheEntry>({ queryKey: queryKeys.posts }, (entry) => {
    if (!entry) return entry;
    if (isInfinite(entry)) {
      return {
        ...entry,
        pages: entry.pages.map((page) => ({
          ...page,
          items: page.items.map((post) => patchPost(post, id, update)),
        })),
      };
    }
    return patchPost(entry, id, update);
  });
}

/** Removes post `id` (and reposts of it) from every cached list, e.g. after deletion. */
export function removePostEverywhere(queryClient: QueryClient, id: string): void {
  queryClient.setQueriesData<PostCacheEntry>({ queryKey: queryKeys.posts }, (entry) => {
    if (!isInfinite(entry)) return entry;
    return {
      ...entry,
      pages: entry.pages.map((page) => ({
        ...page,
        items: page.items.filter(
          (post) => post.id !== id && !(post.kind === 'repost' && post.sharedPost?.id === id),
        ),
      })),
    };
  });
}

/** Snapshot of every post query, for rolling back an optimistic update. */
export function snapshotPosts(queryClient: QueryClient) {
  return queryClient.getQueriesData<PostCacheEntry>({ queryKey: queryKeys.posts });
}

export function restorePosts(queryClient: QueryClient, snapshot: ReturnType<typeof snapshotPosts>) {
  for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
}
