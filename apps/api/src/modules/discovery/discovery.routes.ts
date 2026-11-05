import { hashtagParamsSchema, paginationQuerySchema, suggestionsQuerySchema } from '@vibe/shared';
import { Router } from 'express';
import { sendData, sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import type { DiscoveryService } from './discovery.service.js';

/** Mounted at /hashtags. */
export function createHashtagRouter({
  discovery,
  auth,
}: {
  discovery: DiscoveryService;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  router.use(auth.requireOnboarded);
  router.get(
    '/:tag/posts',
    validated(
      { params: hashtagParamsSchema, query: paginationQuerySchema },
      async ({ params, query }, req, res) => {
        const { items, meta } = await discovery.hashtagPosts(currentUser(req), params.tag, query);
        sendPage(res, items, meta);
      },
    ),
  );
  return router;
}

/** Mounted at /explore. */
export function createExploreRouter({
  discovery,
  auth,
}: {
  discovery: DiscoveryService;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  router.use(auth.requireOnboarded);
  router.get('/trending', async (_req, res) => {
    sendData(res, await discovery.trending());
  });
  router.get(
    '/suggestions',
    validated({ query: suggestionsQuerySchema }, async ({ query }, req, res) => {
      sendData(res, await discovery.suggestions(currentUser(req), query.limit));
    }),
  );
  return router;
}
