import { MESSAGE_TEXT_MAX } from '@vibe/shared';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useParams } from 'react-router';
import { BackIcon, SendIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useMe } from '@/features/account/api';
import { getSocket } from '@/lib/realtime';
import { fullDate } from '@/lib/time';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { useActiveConversation, useTyping } from '@/stores/typing';
import {
  useConversation,
  useMarkRead,
  useMessages,
  useSendMessage,
  type ThreadMessage,
} from './api';

/** Matches the server's throttle: no point sending typing signals faster than it relays them. */
const TYPING_SIGNAL_MS = 1_500;

function useIsTyping(conversationId: string): boolean {
  return useTyping((state) => state.at[conversationId] !== undefined);
}

function Composer({
  conversationId,
  meId,
  disabled,
}: {
  conversationId: string;
  meId: string;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const send = useSendMessage(conversationId, meId);
  const lastSignal = useRef(0);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    send.mutate({ text: trimmed, clientId: crypto.randomUUID() });
    setText('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  const onChange = (value: string) => {
    setText(value);
    const now = Date.now();
    if (value && now - lastSignal.current > TYPING_SIGNAL_MS) {
      lastSignal.current = now;
      getSocket().emit('typing', { conversationId });
    }
  };

  if (disabled) {
    return (
      <p className="border-t border-border px-4 py-4 text-center text-sm text-muted">
        You can&apos;t message this account.
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="flex items-end gap-2 border-t border-border px-4 py-3">
      <label htmlFor="message-text" className="sr-only">
        Message
      </label>
      <textarea
        id="message-text"
        rows={1}
        value={text}
        maxLength={MESSAGE_TEXT_MAX}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Write a message"
        className="max-h-32 min-h-10 flex-1 resize-none rounded-2xl border border-border bg-bg px-4 py-2 text-[15px] outline-none focus:border-accent"
      />
      <button
        type="submit"
        aria-label="Send"
        disabled={!text.trim()}
        className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-contrast disabled:opacity-40"
      >
        <SendIcon className="size-5" />
      </button>
    </form>
  );
}

function Bubble({
  message,
  mine,
  onRetry,
}: {
  message: ThreadMessage;
  mine: boolean;
  onRetry: () => void;
}) {
  return (
    <li className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      <p
        title={fullDate(message.createdAt)}
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-[15px] break-words whitespace-pre-wrap ${
          mine ? 'bg-accent text-accent-contrast' : 'bg-surface'
        } ${message.pending ? 'opacity-60' : ''}`}
      >
        {message.text}
      </p>
      {message.failed && (
        <button type="button" onClick={onRetry} className="mt-1 text-xs font-semibold text-danger">
          Not sent · Retry
        </button>
      )}
    </li>
  );
}

export function ConversationPage() {
  const { conversationId = '' } = useParams();
  const { data: me } = useMe();
  const conversation = useConversation(conversationId);
  const messages = useMessages(conversationId);
  const markRead = useMarkRead(conversationId);
  const retry = useSendMessage(conversationId, me?.id ?? '');
  const typing = useIsTyping(conversationId);
  const setActive = useActiveConversation((state) => state.set);
  const bottom = useRef<HTMLDivElement | null>(null);

  // Older pages load as the top of the thread scrolls into view.
  const top = useInfiniteScroll(() => {
    if (messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage();
  }, messages.hasNextPage);

  useEffect(() => {
    setActive(conversationId);
    return () => setActive(null);
  }, [conversationId, setActive]);

  // Oldest first on screen; the API (and cache) are newest first.
  const thread = [...(messages.data?.pages.flatMap((page) => page.items) ?? [])].reverse();
  const newest = thread.at(-1);
  const newestFromOtherId = [...thread]
    .reverse()
    .find((m) => m.senderId !== me?.id && !m.pending)?.id;

  // Reading the conversation (on open, and as their messages arrive) clears its unread count.
  const { mutate: read } = markRead;
  useEffect(() => {
    if (newestFromOtherId && document.visibilityState === 'visible') read();
  }, [newestFromOtherId, read]);

  // Keep the newest message in view as messages arrive.
  useLayoutEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [newest?.id, typing]);

  if (conversation.isError) {
    return <ErrorState error={conversation.error} onRetry={() => void conversation.refetch()} />;
  }
  const other = conversation.data?.user;
  const mineLast = [...thread].reverse().find((m) => m.senderId === me?.id && !m.pending);
  const seen =
    mineLast &&
    conversation.data?.otherLastReadAt &&
    conversation.data.otherLastReadAt >= mineLast.createdAt &&
    newest?.id === mineLast.id;

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col sm:h-dvh">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link
          to="/messages"
          aria-label="Back to messages"
          className="rounded-full p-1 hover:bg-surface-hover"
        >
          <BackIcon className="size-5" />
        </Link>
        {other ? (
          <Link to={`/${other.username}`} className="flex min-w-0 items-center gap-2">
            <Avatar src={other.avatarUrl} name={other.displayName} size="sm" />
            <span className="min-w-0">
              <span className="block truncate font-semibold">{other.displayName}</span>
              <span className="block truncate text-xs text-muted">@{other.username}</span>
            </span>
          </Link>
        ) : (
          <Skeleton className="h-8 w-40" />
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div ref={top} />
        {messages.isPending ? (
          <div className="space-y-3" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : messages.isError ? (
          <ErrorState error={messages.error} onRetry={() => void messages.refetch()} />
        ) : (
          <ol aria-label="Messages" className="flex flex-col gap-2">
            {thread.map((message) => (
              <Bubble
                key={message.clientId}
                message={message}
                mine={message.senderId === me?.id}
                onRetry={() => retry.mutate({ text: message.text, clientId: message.clientId })}
              />
            ))}
          </ol>
        )}
        {seen && <p className="mt-1 text-right text-xs text-muted">Seen</p>}
        {typing && other && (
          <p className="mt-2 text-sm text-muted" aria-live="polite">
            {other.displayName} is typing…
          </p>
        )}
        <div ref={bottom} />
      </div>

      {me && conversation.data && (
        <Composer
          conversationId={conversationId}
          meId={me.id}
          disabled={!conversation.data.canSend}
        />
      )}
    </div>
  );
}
