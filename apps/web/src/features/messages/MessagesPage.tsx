import { Link } from 'react-router';
import { MessageIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useMe } from '@/features/account/api';
import { timeAgo } from '@/lib/time';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { useConversations } from './api';

/** The inbox: one row per conversation, most recent activity first, unread ones in bold. */
export function MessagesPage() {
  const { data: me } = useMe();
  const conversations = useConversations();
  const sentinel = useInfiniteScroll(() => {
    if (conversations.hasNextPage && !conversations.isFetchingNextPage) {
      void conversations.fetchNextPage();
    }
  }, conversations.hasNextPage);

  const items = conversations.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader title="Messages" />
      {conversations.isPending ? (
        <div className="space-y-3 p-4" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : conversations.isError ? (
        <ErrorState error={conversations.error} onRetry={() => void conversations.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<MessageIcon />}
          title="No messages yet"
          description="Open someone's profile and tap Message to start a conversation."
          action={
            <Link to="/search" className="text-sm font-semibold text-accent hover:underline">
              Find people
            </Link>
          }
        />
      ) : (
        <ul aria-label="Conversations" className="divide-y divide-border">
          {items.map((conversation) => {
            const last = conversation.lastMessage;
            const unread = conversation.unread > 0;
            return (
              <li key={conversation.id}>
                <Link
                  to={`/messages/${conversation.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
                >
                  <Avatar src={conversation.user.avatarUrl} name={conversation.user.displayName} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`truncate ${unread ? 'font-bold' : 'font-semibold'}`}>
                        {conversation.user.displayName}
                      </span>
                      {last && (
                        <time dateTime={last.createdAt} className="shrink-0 text-xs text-muted">
                          {timeAgo(last.createdAt)}
                        </time>
                      )}
                    </span>
                    <span
                      className={`block truncate text-sm ${unread ? 'font-semibold text-text' : 'text-muted'}`}
                    >
                      {last ? `${last.senderId === me?.id ? 'You: ' : ''}${last.text}` : ''}
                    </span>
                  </span>
                  {unread && (
                    <span
                      className="min-w-5 rounded-full bg-accent px-1.5 text-center text-xs font-bold text-accent-contrast"
                      aria-label={`${conversation.unread} unread`}
                    >
                      {conversation.unread > 99 ? '99+' : conversation.unread}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div ref={sentinel} />
    </>
  );
}
