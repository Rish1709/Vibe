import type { NotificationDto } from '@vibe/shared';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { BellIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { imageUrl } from '@/lib/media';
import { timeAgo } from '@/lib/time';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { useMarkAllRead, useNotifications } from './api';

function describe(notification: NotificationDto): string {
  switch (notification.type) {
    case 'like':
      return 'liked your post';
    case 'comment':
      return 'commented on your post';
    case 'reply':
      return 'replied to your comment';
    case 'follow':
      return 'started following you';
    case 'follow_request':
      return 'wants to follow you';
    case 'follow_accept':
      return 'accepted your follow request';
  }
}

/** Where tapping a notification goes. */
function targetOf(notification: NotificationDto): string {
  if (notification.type === 'follow_request') return '/settings';
  if (notification.post) return `/p/${notification.post.id}`;
  return `/${notification.actor.username}`;
}

export function NotificationsPage() {
  const notifications = useNotifications();
  const markAllRead = useMarkAllRead();
  const sentinel = useInfiniteScroll(() => {
    if (notifications.hasNextPage && !notifications.isFetchingNextPage) {
      void notifications.fetchNextPage();
    }
  }, notifications.hasNextPage);

  // Opening the page reads everything; highlighting still shows what was new on this visit.
  const loaded = notifications.isSuccess;
  const { mutate: readAll } = markAllRead;
  useEffect(() => {
    if (loaded) readAll();
  }, [loaded, readAll]);

  const items = notifications.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader title="Notifications" />
      {notifications.isPending ? (
        <div className="space-y-3 p-4" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : notifications.isError ? (
        <ErrorState error={notifications.error} onRetry={() => void notifications.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BellIcon />}
          title="Nothing yet"
          description="Likes, comments, replies and new followers show up here."
        />
      ) : (
        <ul aria-label="Notifications" className="divide-y divide-border">
          {items.map((notification) => (
            <li key={notification.id} className={notification.read ? '' : 'bg-accent/5'}>
              <Link
                to={targetOf(notification)}
                className="flex items-start gap-3 px-4 py-3 hover:bg-surface-hover"
              >
                <Avatar src={notification.actor.avatarUrl} name={notification.actor.displayName} />
                <span className="min-w-0 flex-1 text-[15px]">
                  <span>
                    <strong className="font-semibold">{notification.actor.displayName}</strong>{' '}
                    {describe(notification)}
                  </span>
                  {(notification.comment ?? notification.post) && (
                    <span className="mt-0.5 block truncate text-sm text-muted">
                      {notification.comment?.text ?? notification.post?.text}
                    </span>
                  )}
                  <time dateTime={notification.createdAt} className="block text-xs text-muted">
                    {timeAgo(notification.createdAt)}
                  </time>
                </span>
                {notification.post?.thumbnailUrl && (
                  <img
                    src={imageUrl(notification.post.thumbnailUrl, 96)}
                    alt=""
                    className="size-12 shrink-0 rounded-md object-cover"
                  />
                )}
                {!notification.read && <span className="sr-only">New</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div ref={sentinel} />
    </>
  );
}
