import type { InfiniteData, UseInfiniteQueryResult } from '@tanstack/react-query';
import type { UserListItemDto } from '@vibe/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { LockIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import type { Page } from '@/lib/pagination';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { useFollowUser } from './api';
import { FollowButton } from './FollowButton';

export function UserRow({
  user,
  action,
}: {
  user: UserListItemDto & { isPrivate?: boolean };
  action?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <Link to={`/${user.username}`} className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar src={user.avatarUrl} name={user.displayName} />
        <span className="min-w-0">
          <span className="flex items-center gap-1 font-semibold">
            <span className="truncate">{user.displayName}</span>
            {user.isPrivate && (
              <LockIcon className="size-3.5 shrink-0 text-muted" aria-label="Private account" />
            )}
          </span>
          <span className="block truncate text-sm text-muted">@{user.username}</span>
        </span>
      </Link>
      {action}
    </li>
  );
}

export function UserList({
  query,
  empty,
}: {
  query: UseInfiniteQueryResult<InfiniteData<Page<UserListItemDto>>>;
  empty: ReactNode;
}) {
  const follow = useFollowUser();
  const sentinel = useInfiniteScroll(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, query.hasNextPage);

  if (query.isPending) {
    return (
      <div className="space-y-3 p-4" aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const users = query.data.pages.flatMap((page) => page.items);
  if (users.length === 0) return <>{empty}</>;
  return (
    <>
      <ul className="divide-y divide-border">
        {users.map((user) => (
          <UserRow
            key={user.id}
            user={user}
            action={
              user.viewer && (
                <FollowButton
                  size="sm"
                  state={user.viewer.following}
                  pending={follow.isPending && follow.variables.userId === user.id}
                  onChange={(next) => follow.mutate({ userId: user.id, follow: next })}
                />
              )
            }
          />
        ))}
      </ul>
      <div ref={sentinel} />
    </>
  );
}
