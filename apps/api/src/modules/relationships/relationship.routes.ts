import { idParamsSchema, objectIdSchema, paginationQuerySchema } from '@vibe/shared';
import { Router } from 'express';
import { z } from 'zod';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import { sendData, sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import type { BlockService } from './block.service.js';
import type { FollowService } from './follow.service.js';

interface RelationshipRouterDeps {
  follows: FollowService;
  blocks: BlockService;
  auth: AuthMiddleware;
  limiter: RateLimiter;
}

const requestParamsSchema = z.object({ requestId: objectIdSchema });

/** Mounted at /users. Toggles use PUT/DELETE so they are idempotent and safe to retry. */
export function createRelationshipRouter({
  follows,
  blocks,
  auth,
  limiter,
}: RelationshipRouterDeps): Router {
  const router = Router();
  const graphWrites = rateLimit(limiter, RateLimits.graphWrites);
  router.use(auth.requireOnboarded);

  router.get(
    '/me/follow-requests',
    validated({ query: paginationQuerySchema }, async ({ query }, req, res) => {
      const { items, meta } = await follows.listRequests(currentUser(req), query);
      sendPage(res, items, meta);
    }),
  );
  router.post(
    '/me/follow-requests/:requestId/accept',
    graphWrites,
    validated({ params: requestParamsSchema }, async ({ params }, req, res) => {
      await follows.acceptRequest(currentUser(req), params.requestId);
      res.status(204).end();
    }),
  );
  router.delete(
    '/me/follow-requests/:requestId',
    graphWrites,
    validated({ params: requestParamsSchema }, async ({ params }, req, res) => {
      await follows.declineRequest(currentUser(req), params.requestId);
      res.status(204).end();
    }),
  );
  router.get(
    '/me/blocks',
    validated({ query: paginationQuerySchema }, async ({ query }, req, res) => {
      const { items, meta } = await blocks.listBlocked(currentUser(req), query);
      sendPage(res, items, meta);
    }),
  );

  router.put(
    '/:id/follow',
    graphWrites,
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      sendData(res, await follows.follow(currentUser(req), params.id));
    }),
  );
  router.delete(
    '/:id/follow',
    graphWrites,
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      sendData(res, await follows.unfollow(currentUser(req), params.id));
    }),
  );
  router.delete(
    '/:id/follower',
    graphWrites,
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      await follows.removeFollower(currentUser(req), params.id);
      res.status(204).end();
    }),
  );
  router.get(
    '/:id/followers',
    validated(
      { params: idParamsSchema, query: paginationQuerySchema },
      async ({ params, query }, req, res) => {
        const { items, meta } = await follows.listFollowers(currentUser(req), params.id, query);
        sendPage(res, items, meta);
      },
    ),
  );
  router.get(
    '/:id/following',
    validated(
      { params: idParamsSchema, query: paginationQuerySchema },
      async ({ params, query }, req, res) => {
        const { items, meta } = await follows.listFollowing(currentUser(req), params.id, query);
        sendPage(res, items, meta);
      },
    ),
  );
  router.put(
    '/:id/block',
    graphWrites,
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      await blocks.block(currentUser(req), params.id);
      res.status(204).end();
    }),
  );
  router.delete(
    '/:id/block',
    graphWrites,
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      await blocks.unblock(currentUser(req), params.id);
      res.status(204).end();
    }),
  );

  return router;
}
