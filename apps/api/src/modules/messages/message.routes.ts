import {
  idParamsSchema,
  openConversationSchema,
  paginationQuerySchema,
  sendMessageSchema,
} from '@vibe/shared';
import { Router } from 'express';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import { sendData, sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import type { MessageService } from './message.service.js';

/** Mounted at /conversations. */
export function createMessageRouter({
  messages,
  auth,
  limiter,
}: {
  messages: MessageService;
  auth: AuthMiddleware;
  limiter: RateLimiter;
}): Router {
  const router = Router();
  router.use(auth.requireOnboarded);
  const messageWrites = rateLimit(limiter, RateLimits.messageWrites);

  router.get(
    '/',
    validated({ query: paginationQuerySchema }, async ({ query }, req, res) => {
      const { items, meta } = await messages.list(currentUser(req), query);
      sendPage(res, items, meta);
    }),
  );
  router.post(
    '/',
    messageWrites,
    validated({ body: openConversationSchema }, async ({ body }, req, res) => {
      sendData(res, await messages.open(currentUser(req), body.userId));
    }),
  );
  router.get(
    '/:id',
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      sendData(res, await messages.get(currentUser(req), params.id));
    }),
  );
  router.get(
    '/:id/messages',
    validated(
      { params: idParamsSchema, query: paginationQuerySchema },
      async ({ params, query }, req, res) => {
        const { items, meta } = await messages.messages(currentUser(req), params.id, query);
        sendPage(res, items, meta);
      },
    ),
  );
  router.post(
    '/:id/messages',
    messageWrites,
    validated(
      { params: idParamsSchema, body: sendMessageSchema },
      async ({ params, body }, req, res) => {
        const { message, created } = await messages.send(currentUser(req), params.id, body);
        // 201 for a new message, 200 when a retry returns the one already stored.
        sendData(res, message, created ? 201 : 200);
      },
    ),
  );
  router.post(
    '/:id/read',
    validated({ params: idParamsSchema }, async ({ params }, req, res) => {
      await messages.markRead(currentUser(req), params.id);
      res.status(204).end();
    }),
  );

  return router;
}
