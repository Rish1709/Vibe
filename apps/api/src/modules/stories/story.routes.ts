import { createStorySchema, idParamsSchema, paginationQuerySchema } from '@vibe/shared';
import { Router } from 'express';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import { sendData, sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import type { StoryService } from './story.service.js';

interface StoryRouterDeps {
  stories: StoryService;
  auth: AuthMiddleware;
  limiter: RateLimiter;
}

/** Returns the /stories router and the user-scoped GET /users/:id/stories route. */
export function createStoryRouters({ stories, auth, limiter }: StoryRouterDeps) {
  const storyWrites = rateLimit(limiter, RateLimits.storyWrites);
  const router = Router();
  router.use(auth.requireOnboarded);

  router.post(
    '/',
    storyWrites,
    validated({ body: createStorySchema }, async ({ body }, req, res) => {
      sendData(res, await stories.create(currentUser(req), body), 201);
    }),
  );
  router.get(
    '/tray',
    validated({}, async (_input, req, res) => {
      sendData(res, await stories.tray(currentUser(req)));
    }),
  );
  router.post(
    '/:id/views',
    rateLimit(limiter, RateLimits.storyViews),
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      sendData(res, await stories.markViewed(currentUser(req), params.id));
    }),
  );
  router.get(
    '/:id/viewers',
    validated(
      { params: idParamsSchema, query: paginationQuerySchema },
      async ({ params, query }, req, res) => {
        const { items, meta } = await stories.listViewers(currentUser(req), params.id, query);
        sendPage(res, items, meta);
      },
    ),
  );
  router.delete(
    '/:id',
    storyWrites,
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      await stories.remove(currentUser(req), params.id);
      res.status(204).end();
    }),
  );

  const userStoriesRouter = Router();
  userStoriesRouter.get(
    '/:id/stories',
    auth.requireOnboarded,
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      sendData(res, await stories.listForUser(currentUser(req), params.id));
    }),
  );

  return { storyRouter: router, userStoriesRouter };
}
