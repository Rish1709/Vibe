import type { AuthUser } from '../modules/users/user.service.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. Read it through `currentUser(req)`, which fails loudly if absent. */
      user?: AuthUser;
    }
  }
}

export {};
