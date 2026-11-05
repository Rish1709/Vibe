import type { Emitter } from '@socket.io/redis-emitter';
import type { ServerToClientEvents } from '@vibe/shared';
import type { Server } from 'socket.io';

export type RealtimeEvent = keyof ServerToClientEvents;
export type RealtimePayload<E extends RealtimeEvent> = Parameters<ServerToClientEvents[E]>[0];

/**
 * Boundary between services and the socket layer: services say "tell user X about Y" and never touch
 * Socket.IO. Every connected socket joins its user's room, so one emit reaches all of a user's tabs
 * and devices, on whichever API instance they are connected to (the Redis adapter relays it).
 *
 * Delivery is best effort: a user who is offline simply misses the push and sees the data on their
 * next read, because everything pushed is also persisted and readable over REST.
 */
export interface RealtimePublisher {
  toUser<E extends RealtimeEvent>(userId: string, event: E, payload: RealtimePayload<E>): void;
  /** Ends a user's open connections, e.g. when the account is deleted. */
  disconnectUser(userId: string): void;
}

export const userRoom = (userId: string) => `user:${userId}`;

/** Used by API instances, which own the Socket.IO server. */
export function createSocketPublisher(
  io: Server<Record<string, never>, ServerToClientEvents>,
): RealtimePublisher {
  return {
    toUser(userId, event, payload) {
      // The generic event-map types can't be narrowed through a computed event name.
      (io.to(userRoom(userId)).emit as (e: string, p: unknown) => boolean)(event, payload);
    },
    disconnectUser(userId) {
      io.in(userRoom(userId)).disconnectSockets(true);
    },
  };
}

/**
 * Used by the worker, which has no sockets of its own: it publishes into Redis and every API
 * instance's adapter delivers to the sockets it holds.
 */
export function createEmitterPublisher(emitter: Emitter<ServerToClientEvents>): RealtimePublisher {
  return {
    toUser(userId, event, payload) {
      (emitter.to(userRoom(userId)).emit as (e: string, p: unknown) => boolean)(event, payload);
    },
    disconnectUser(userId) {
      emitter.in(userRoom(userId)).disconnectSockets(true);
    },
  };
}

/** For processes and tests without sockets: records what would have been sent. */
export function createRecordingPublisher() {
  const sent: { userId: string; event: RealtimeEvent; payload: unknown }[] = [];
  const disconnected: string[] = [];
  const publisher: RealtimePublisher = {
    toUser: (userId, event, payload) => {
      sent.push({ userId, event, payload });
    },
    disconnectUser: (userId) => {
      disconnected.push(userId);
    },
  };
  return { publisher, sent, disconnected };
}
