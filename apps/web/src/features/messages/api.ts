import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import type { ConversationDto, MessageDto, UnreadCountsDto } from '@vibe/shared';
import { apiRequest } from '@/lib/apiClient';
import { fetchPage, pageOptions, type Page } from '@/lib/pagination';
import { queryKeys } from '@/lib/queryKeys';

type MessagePages = InfiniteData<Page<MessageDto>, string | null>;
type ConversationPages = InfiniteData<Page<ConversationDto>, string | null>;

/** A message the server hasn't confirmed yet. Its id is the clientId until the real one arrives. */
export type ThreadMessage = MessageDto & { pending?: boolean; failed?: boolean };

export const useConversations = () =>
  useInfiniteQuery({
    queryKey: queryKeys.conversations,
    queryFn: ({ pageParam, signal }) =>
      fetchPage<ConversationDto>('/api/v1/conversations', pageParam, signal),
    ...pageOptions,
  });

export const useConversation = (id: string) =>
  useQuery({
    queryKey: queryKeys.conversation(id),
    queryFn: async ({ signal }) =>
      (await apiRequest<ConversationDto>(`/api/v1/conversations/${id}`, { signal })).data,
  });

/** Newest first, like the API; the thread renders them reversed and loads older pages upward. */
export const useMessages = (conversationId: string) =>
  useInfiniteQuery({
    queryKey: queryKeys.messages(conversationId),
    queryFn: ({ pageParam, signal }) =>
      fetchPage<ThreadMessage>(
        `/api/v1/conversations/${conversationId}/messages?limit=30`,
        pageParam,
        signal,
      ),
    ...pageOptions,
  });

export const useUnreadCounts = () =>
  useQuery({
    queryKey: queryKeys.unreadCounts,
    queryFn: async ({ signal }) =>
      (await apiRequest<UnreadCountsDto>('/api/v1/notifications/unread-counts', { signal })).data,
    staleTime: 60_000,
  });

/**
 * Puts a message into its cached thread, newest first. Matches on id or clientId, so the optimistic
 * copy, the REST response and the socket push (whichever arrive, in any order) end up as one message.
 */
export function upsertMessage(queryClient: QueryClient, message: ThreadMessage) {
  queryClient.setQueryData<MessagePages>(queryKeys.messages(message.conversationId), (data) => {
    if (!data) return data;
    const matches = (m: ThreadMessage) => m.id === message.id || m.clientId === message.clientId;
    const exists = data.pages.some((page) => page.items.some(matches));
    const pages = exists
      ? data.pages.map((page) => ({
          ...page,
          items: page.items.map((m) => (matches(m) ? message : m)),
        }))
      : data.pages.map((page, index) =>
          index === 0 ? { ...page, items: [message, ...page.items] } : page,
        );
    return { ...data, pages };
  });
}

/** Moves a conversation to the top of the cached inbox with its new preview. */
export function bumpConversation(
  queryClient: QueryClient,
  message: MessageDto,
  { unreadDelta }: { unreadDelta: number },
) {
  let found = false;
  queryClient.setQueryData<ConversationPages>(queryKeys.conversations, (data) => {
    if (!data) return data;
    let moved: ConversationDto | undefined;
    const pages = data.pages.map((page) => ({
      ...page,
      items: page.items.filter((conversation) => {
        if (conversation.id !== message.conversationId) return true;
        moved = conversation;
        return false;
      }),
    }));
    if (!moved) return data;
    found = true;
    const updated: ConversationDto = {
      ...moved,
      lastMessage: {
        id: message.id,
        senderId: message.senderId,
        text: message.text,
        createdAt: message.createdAt,
      },
      unread: Math.max(0, moved.unread + unreadDelta),
    };
    return {
      ...data,
      pages: pages.map((page, index) =>
        index === 0 ? { ...page, items: [updated, ...page.items] } : page,
      ),
    };
  });
  // A conversation not in the cache (new, or on a later page): fetch the inbox again.
  if (!found) void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
}

export function useSendMessage(conversationId: string, meId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ text, clientId }: { text: string; clientId: string }) =>
      (
        await apiRequest<MessageDto>(`/api/v1/conversations/${conversationId}/messages`, {
          method: 'POST',
          body: { text, clientId },
        })
      ).data,
    onMutate: ({ text, clientId }) => {
      upsertMessage(queryClient, {
        id: clientId,
        clientId,
        conversationId,
        senderId: meId,
        text,
        createdAt: new Date().toISOString(),
        pending: true,
      });
    },
    onSuccess: (message) => {
      upsertMessage(queryClient, message);
      bumpConversation(queryClient, message, { unreadDelta: 0 });
    },
    onError: (_err, { text, clientId }) => {
      // Kept in the thread, marked failed, so the user can retry with the same clientId.
      upsertMessage(queryClient, {
        id: clientId,
        clientId,
        conversationId,
        senderId: meId,
        text,
        createdAt: new Date().toISOString(),
        failed: true,
      });
    },
  });
}

/** Clears this conversation's unread count everywhere it is cached. */
export function applyRead(queryClient: QueryClient, conversationId: string) {
  let cleared = 0;
  queryClient.setQueryData<ConversationPages>(queryKeys.conversations, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            items: page.items.map((conversation) => {
              if (conversation.id !== conversationId || conversation.unread === 0)
                return conversation;
              cleared = 1;
              return { ...conversation, unread: 0 };
            }),
          })),
        }
      : data,
  );
  queryClient.setQueryData<UnreadCountsDto>(queryKeys.unreadCounts, (counts) =>
    counts && cleared ? { ...counts, messages: Math.max(0, counts.messages - cleared) } : counts,
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.unreadCounts });
}

export function useMarkRead(conversationId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/conversations/${conversationId}/read`, { method: 'POST' }),
    onMutate: () => applyRead(queryClient, conversationId),
  });
}

export function useOpenConversation() {
  return useMutation({
    mutationFn: async (userId: string) =>
      (
        await apiRequest<ConversationDto>('/api/v1/conversations', {
          method: 'POST',
          body: { userId },
        })
      ).data,
  });
}
