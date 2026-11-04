import { paginationQuerySchema } from '@vibe/shared';
import { Router } from 'express';
import { sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import type { FeedService } from './feed.service.js';

export function createFeedRouter({
  feed,
  auth,
}: {
  feed: FeedService;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  router.get(
    '/',
    auth.requireOnboarded,
    validated({ query: paginationQuerySchema }, async ({ query }, req, res) => {
      const page = await feed.getFeed(currentUser(req), query);
      // Which path served the page: makes cache behaviour observable in logs, tests and benchmarks.
      res.setHeader('X-Feed-Source', page.source);
      sendPage(res, page.items, page.meta);
    }),
  );
  return router;
}
