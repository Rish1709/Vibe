import type { MessageDto } from './messages.js';
import type { NotificationType } from './notifications.js';

/**
 * Socket.IO event contracts, shared so the server and the browser are type-checked against the same
 * shapes. Sockets carry only pushes and ephemeral signals; every durable write goes through REST.
 */
export interface ServerToClientEvents {
  /** A new message in one of the user's conversations (also echoed to the sender's other tabs). */
  'message:new': (message: MessageDto) => void;
  /** The other participant read the conversation. */
  'conversation:read': (event: { conversationId: string; userId: string; readAt: string }) => void;
  typing: (event: { conversationId: string; userId: string }) => void;
  'notification:new': (event: { type: NotificationType; unreadCount: number }) => void;
  /** Unread notification count changed elsewhere (e.g. marked read in another tab). */
  'notification:count': (event: { unreadCount: number }) => void;
}

export interface ClientToServerEvents {
  typing: (event: { conversationId: string }) => void;
}

/** Error codes a rejected socket connection reports in `err.data.code`. */
export const SOCKET_AUTH_ERRORS = [
  'UNAUTHENTICATED',
  'ONBOARDING_REQUIRED',
  'ACCOUNT_DELETED',
] as const;
export type SocketAuthError = (typeof SOCKET_AUTH_ERRORS)[number];
