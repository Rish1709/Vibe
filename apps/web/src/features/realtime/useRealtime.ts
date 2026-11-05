import { useQueryClient } from '@tanstack/react-query';
import type { ConversationDto, MessageDto, UnreadCountsDto } from '@vibe/shared';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';
import { getSocket } from '@/lib/realtime';
import { useActiveConversation, useTyping } from '@/stores/typing';
import { applyRead, bumpConversation, upsertMessage } from '../messages/api';

/** A rejected handshake isn't retried by Socket.IO itself; try again after this long. */
const RETRY_AFTER_REJECT_MS = 5_000;

/**
 * Owns the tab's socket while the user is signed in, and applies pushes to the query cache.
 *
 * Pushes are best effort (the server doesn't queue them for offline users), so after any reconnect
 * the data they would have changed is refetched: a dropped connection can delay an update but can
 * never lose one.
 */
export function useRealtime(meId: string) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();
    let connectedBefore = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const setCounts = (patch: Partial<UnreadCountsDto>) =>
      queryClient.setQueryData<UnreadCountsDto>(queryKeys.unreadCounts, (counts) =>
        counts ? { ...counts, ...patch } : counts,
      );

    const onConnect = () => {
      if (connectedBefore) {
        for (const queryKey of [
          queryKeys.conversations,
          ['messages'],
          queryKeys.notifications,
          queryKeys.unreadCounts,
        ]) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }
      connectedBefore = true;
    };
    const onConnectError = () => {
      clearTimeout(retry);
      retry = setTimeout(() => socket.connect(), RETRY_AFTER_REJECT_MS);
    };
    const onMessage = (message: MessageDto) => {
      const fromOther = message.senderId !== meId;
      const onScreen = useActiveConversation.getState().id === message.conversationId;
      upsertMessage(queryClient, message);
      bumpConversation(queryClient, message, { unreadDelta: fromOther && !onScreen ? 1 : 0 });
      if (fromOther) {
        useTyping.getState().clear(message.conversationId);
        // The server counts conversations, not messages; ask it rather than guess.
        if (!onScreen) void queryClient.invalidateQueries({ queryKey: queryKeys.unreadCounts });
      }
    };
    const onRead = ({
      conversationId,
      userId,
      readAt,
    }: {
      conversationId: string;
      userId: string;
      readAt: string;
    }) => {
      if (userId === meId) {
        applyRead(queryClient, conversationId);
        return;
      }
      queryClient.setQueryData<ConversationDto>(queryKeys.conversation(conversationId), (c) =>
        c ? { ...c, otherLastReadAt: readAt } : c,
      );
    };
    const onTyping = ({ conversationId }: { conversationId: string }) => {
      useTyping.getState().mark(conversationId);
    };
    const onNotification = ({ unreadCount }: { unreadCount: number }) => {
      setCounts({ notifications: unreadCount });
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    };
    const onNotificationCount = ({ unreadCount }: { unreadCount: number }) => {
      setCounts({ notifications: unreadCount });
    };

    socket.on('connect', onConnect);
    socket.on('connect_error', onConnectError);
    socket.on('message:new', onMessage);
    socket.on('conversation:read', onRead);
    socket.on('typing', onTyping);
    socket.on('notification:new', onNotification);
    socket.on('notification:count', onNotificationCount);
    socket.connect();

    return () => {
      clearTimeout(retry);
      socket.off('connect', onConnect);
      socket.off('connect_error', onConnectError);
      socket.off('message:new', onMessage);
      socket.off('conversation:read', onRead);
      socket.off('typing', onTyping);
      socket.off('notification:new', onNotification);
      socket.off('notification:count', onNotificationCount);
      socket.disconnect();
    };
  }, [meId, queryClient]);
}
