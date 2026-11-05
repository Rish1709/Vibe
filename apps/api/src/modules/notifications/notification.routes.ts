import type { UnreadCountsDto } from '@vibe/shared';
import { paginationQuerySchema } from '@vibe/shared';
import { Router } from 'express';
import { sendData, sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import type { MessageService } from '../messages/message.service.js';
import type { NotificationService } from './notification.service.js';

/** Mounted at /notifications. */
export function createNotificationRouter({
  notifications,
  messages,
  auth,
}: {
  notifications: NotificationService;
  messages: MessageService;
  auth: AuthMiddleware;
}): Router {
  const router = Router();
  router.use(auth.requireOnboarded);

  router.get(
    '/',
    validated({ query: paginationQuerySchema }, async ({ query }, req, res) => {
      const { items, meta } = await notifications.list(currentUser(req), query);
      sendPage(res, items, meta);
    }),
  );
  /** Both badges in one request: the app shell polls nothing, it reads this once and listens. */
  router.get('/unread-counts', async (req, res) => {
    const viewer = currentUser(req);
    const [notificationCount, messageCount] = await Promise.all([
      notifications.unreadCount(viewer),
      messages.unreadConversations(viewer),
    ]);
    const counts: UnreadCountsDto = { notifications: notificationCount, messages: messageCount };
    sendData(res, counts);
  });
  router.post('/read', async (req, res) => {
    await notifications.markAllRead(currentUser(req));
    res.status(204).end();
  });

  return router;
}
