import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { PostDto } from '@vibe/shared';
import type { ReactNode } from 'react';
import { ErrorState } from '@/components/ui/ErrorState';
import type { Page } from '@/lib/pagination';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { PostCard, PostCardSkeleton } from './PostCard';

interface PostListProps {
  query: UseInfiniteQueryResult<InfiniteData<Page<PostDto>>>;
  empty: ReactNode;
}

/** Renders any paginated post query with skeletons, error, empty state and infinite scroll. */
export function PostList({ query, empty }: PostListProps) {
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = query;
  const sentinel = useInfiniteScroll(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, hasNextPage);

  if (isPending) {
    return (
      <div aria-busy="true" aria-label="Loading posts">
        {Array.from({ length: 4 }, (_, i) => (
          <PostCardSkeleton key={i} />
        ))}
      </div>
    );
  }
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const posts = data.pages.flatMap((page) => page.items);
  if (posts.length === 0 && !hasNextPage) return <>{empty}</>;

  return (
    <div>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
      <div ref={sentinel} />
      {isFetchingNextPage && <PostCardSkeleton />}
      {!hasNextPage && posts.length > 0 && (
        <p className="py-8 text-center text-sm text-muted">You're all caught up</p>
      )}
    </div>
  );
}
