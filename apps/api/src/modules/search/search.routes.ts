import { postSearchQuerySchema, userSearchQuerySchema } from '@vibe/shared';
import { Router } from 'express';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import { sendData, sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import type { DiscoveryService } from '../discovery/discovery.service.js';
import type { SearchService } from './search.service.js';

/** Mounted at /search. Under its own prefix so it can never collide with /users/:username. */
export function createSearchRouter({
  search,
  discovery,
  auth,
  limiter,
}: {
  search: SearchService;
  discovery: DiscoveryService;
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

  router.get(
    '/posts',
    rateLimit(limiter, RateLimits.search),
    validated({ query: postSearchQuerySchema }, async ({ query }, req, res) => {
      const { items, meta } = await discovery.searchPosts(currentUser(req), query.q, query);
      sendPage(res, items, meta);
    }),
  );

  return router;
}
