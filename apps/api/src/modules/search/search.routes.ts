import { userSearchQuerySchema } from '@vibe/shared';
import { Router } from 'express';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import { sendData } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import type { SearchService } from './search.service.js';

/** Mounted at /search. Under its own prefix so it can never collide with /users/:username. */
export function createSearchRouter({
  search,
  auth,
  limiter,
}: {
  search: SearchService;
  auth: AuthMiddleware;
  limiter: RateLimiter;
}): Router {
  const router = Router();
  router.use(auth.requireOnboarded);

  router.get(
    '/users',
    rateLimit(limiter, RateLimits.search),
    validated({ query: userSearchQuerySchema }, async ({ query }, req, res) => {
      sendData(res, await search.searchUsers(currentUser(req), query));
    }),
  );

  return router;
}
