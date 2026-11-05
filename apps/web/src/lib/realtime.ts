import type { ClientToServerEvents, ServerToClientEvents } from '@vibe/shared';
import { io, type Socket } from 'socket.io-client';
import { currentAuthToken } from './apiClient';

export type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: RealtimeSocket | null = null;

/**
 * One socket per tab, created lazily. The auth callback runs on every (re)connect, so each attempt
 * presents a fresh Clerk token (they live about a minute) instead of the one from sign-in.
 */
export function getSocket(): RealtimeSocket {
  socket ??= io(import.meta.env.VITE_API_URL ?? '', {
    autoConnect: false,
    // WebSocket only: no long-polling fallback, so every API instance can stay stateless behind a
    // plain load balancer (polling needs sticky sessions).
    transports: ['websocket'],
    auth: (cb) => {
      void currentAuthToken().then((token) => cb({ token: token ?? '' }));
    },
  });
  return socket;
}
