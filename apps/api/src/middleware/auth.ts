import type { Request, RequestHandler } from 'express';
import type { TokenVerifier } from '../infra/clerk.js';
import { Errors } from '../lib/errors.js';
import type { AuthUser, UserService } from '../modules/users/user.service.js';

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9\-_.]+)$/;

/**
 * Returns the authenticated user. Only valid on routes behind `requireAuth`; if a route forgot the
 * middleware this throws a 500 rather than silently treating the request as anonymous.
 */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw Errors.internal(new Error('currentUser() used on an unauthenticated route'));
  return req.user;
}

export interface AuthMiddleware {
  /** Verifies the bearer token and attaches the local user (provisioning it on first sight). */
  requireAuth: RequestHandler;
  /** Additionally requires a claimed username. Must run after `requireAuth`. */
  requireOnboarded: RequestHandler;
}

export function createAuthMiddleware(verifier: TokenVerifier, users: UserService): AuthMiddleware {
  return {
    requireAuth: async (req, _res, next) => {
      const match = BEARER_PATTERN.exec(req.headers.authorization ?? '');
      if (!match?.[1]) throw Errors.unauthenticated();

      const session = await verifier.verify(match[1]);
      const user = await users.resolveAuthUser(session.clerkUserId);
      if (user.deleted) throw Errors.accountDeleted();

      req.user = user;
      req.log = req.log.child({ userId: user.id });
      next();
    },

    requireOnboarded: (req, _res, next) => {
      if (!currentUser(req).username) throw Errors.onboardingRequired();
      next();
    },
  };
}
