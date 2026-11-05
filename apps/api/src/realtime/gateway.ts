import type { ClientToServerEvents, ServerToClientEvents, SocketAuthError } from '@vibe/shared';
import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { TokenVerifier } from '../infra/clerk.js';
import type { Logger } from '../infra/logger.js';
import type { AuthUser, UserService } from '../modules/users/user.service.js';
import { userRoom, type RealtimePublisher } from './publisher.js';

interface SocketData {
  user: AuthUser;
}

export type RealtimeServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

/** At most one typing signal per conversation per socket in this window. */
const TYPING_THROTTLE_MS = 1_500;

const handshakeSchema = z.object({ token: z.string().min(1).max(8_192) });
const typingSchema = z.object({ conversationId: z.string().regex(/^[a-f\d]{24}$/i) });

interface GatewayDeps {
  io: RealtimeServer;
  tokenVerifier: TokenVerifier;
  users: Pick<UserService, 'resolveAuthUser'>;
  /** Returns the other participant if `userId` belongs to the conversation, else null. */
  otherParticipant: (conversationId: string, userId: string) => Promise<string | null>;
  publisher: RealtimePublisher;
  logger: Logger;
}

function authError(code: SocketAuthError, message: string): Error {
  // Socket.IO hands `data` to the client's connect_error handler, so it can tell "sign in again"
  // apart from a network failure.
  return Object.assign(new Error(message), { data: { code } });
}

/**
 * Authenticates sockets at the handshake with the same token verification and user lookup as REST.
 * A socket is then trusted for its lifetime: session tokens are short-lived (about a minute), so
 * re-checking them would force constant reconnects. Instead, deleting an account disconnects its
 * sockets (see the Clerk webhook), and a reconnect always presents a fresh token.
 */
export function registerGateway({
  io,
  tokenVerifier,
  users,
  otherParticipant,
  publisher,
  logger,
}: GatewayDeps): void {
  /** Resolves to the user, or to the error the client should see. Never rejects. */
  async function authenticate(auth: unknown): Promise<AuthUser | Error> {
    const parsed = handshakeSchema.safeParse(auth);
    if (!parsed.success) return authError('UNAUTHENTICATED', 'Missing token');
    try {
      const session = await tokenVerifier.verify(parsed.data.token);
      const user = await users.resolveAuthUser(session.clerkUserId);
      if (user.deleted) return authError('ACCOUNT_DELETED', 'Account deleted');
      if (!user.username) return authError('ONBOARDING_REQUIRED', 'Finish onboarding first');
      return user;
    } catch (err) {
      logger.debug({ err }, 'Socket authentication failed');
      return authError('UNAUTHENTICATED', 'Invalid token');
    }
  }

  // Socket.IO ignores a middleware's returned promise, so the async work is settled explicitly.
  io.use((socket, next) => {
    void authenticate(socket.handshake.auth).then((result) => {
      if (result instanceof Error) return next(result);
      socket.data.user = result;
      next();
    });
  });

  io.on('connection', (socket: RealtimeSocket) => {
    const { user } = socket.data;
    void socket.join(userRoom(user.id));
    const lastTyping = new Map<string, number>();

    socket.on('typing', (raw) => {
      const parsed = typingSchema.safeParse(raw);
      if (!parsed.success) return;
      const { conversationId } = parsed.data;
      const now = Date.now();
      if (now - (lastTyping.get(conversationId) ?? 0) < TYPING_THROTTLE_MS) return;
      lastTyping.set(conversationId, now);

      otherParticipant(conversationId, user.id)
        .then((other) => {
          // Not a member: silently ignored, so sockets can't probe for conversation ids.
          if (other) publisher.toUser(other, 'typing', { conversationId, userId: user.id });
        })
        .catch((err: unknown) => logger.warn({ err }, 'Typing relay failed'));
    });
  });
}
