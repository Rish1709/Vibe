import { verifyToken } from '@clerk/backend';
import { Errors } from '../lib/errors.js';
import type { Logger } from './logger.js';

export interface VerifiedSession {
  clerkUserId: string;
  sessionId: string;
}

/** Verifies a bearer token and returns the identity it proves. Throws a 401 AppError otherwise. */
export interface TokenVerifier {
  verify(token: string): Promise<VerifiedSession>;
}

interface ClerkVerifierOptions {
  secretKey: string;
  /** PEM public key. When set, verification is local (no network); otherwise JWKS is fetched and cached. */
  jwtKey?: string | undefined;
  /** Origins allowed in the `azp` claim; rejects tokens minted for other frontends. */
  authorizedParties: string[];
  logger: Logger;
}

/**
 * Clerk session tokens are short-lived (60s) RS256 JWTs. Verification checks the signature,
 * `exp`/`nbf` (with clock-skew tolerance) and `azp`. The user id is taken only from the verified `sub`
 * claim; nothing the client sends in bodies or params is ever trusted as identity.
 */
export function createClerkTokenVerifier({
  secretKey,
  jwtKey,
  authorizedParties,
  logger,
}: ClerkVerifierOptions): TokenVerifier {
  return {
    async verify(token) {
      let payload: Awaited<ReturnType<typeof verifyToken>>;
      try {
        payload = await verifyToken(token, {
          secretKey,
          ...(jwtKey && { jwtKey }),
          authorizedParties,
        });
      } catch (err) {
        logger.debug({ err }, 'Session token rejected');
        throw Errors.unauthenticated('Invalid or expired session');
      }
      // Some SDK versions return `{ errors }` instead of throwing.
      if ('errors' in payload && payload.errors) {
        throw Errors.unauthenticated('Invalid or expired session');
      }
      const claims = 'data' in payload && payload.data ? payload.data : payload;
      const { sub, sid } = claims as { sub?: unknown; sid?: unknown };
      if (typeof sub !== 'string' || typeof sid !== 'string') {
        throw Errors.unauthenticated('Token is not a session token');
      }
      return { clerkUserId: sub, sessionId: sid };
    },
  };
}
