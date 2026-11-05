import { NOTIFICATION_TYPES } from '@vibe/shared';
import { Queue } from 'bullmq';
import { z } from 'zod';
import type { Logger } from '../../infra/logger.js';
import type { Redis } from '../../infra/redis.js';

export const NOTIFICATIONS_QUEUE = 'notifications';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);

export const notificationEventSchema = z.object({
  type: z.enum(NOTIFICATION_TYPES),
  actorId: objectId,
  recipientId: objectId,
  postId: objectId.optional(),
  commentId: objectId.optional(),
});
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

/** The same key identifies a queued job and the stored notification. */
export const dedupeKeyOf = (event: Omit<NotificationEvent, 'recipientId'>) =>
  [event.type, event.actorId, event.postId ?? '', event.commentId ?? ''].join('-');

/** Producer side, used by API services. */
export interface NotificationQueue {
  enqueue(event: NotificationEvent): Promise<void>;
  close(): Promise<void>;
}

export function createNotificationQueue(connection: Redis, prefix: string): NotificationQueue {
  const queue = new Queue<NotificationEvent>(NOTIFICATIONS_QUEUE, { connection, prefix });
  return {
    async enqueue(event) {
      await queue.add(event.type, event, {
        // Collapses duplicate enqueues while a job waits. Completed jobs are removed at once, so a
        // later identical event (like, unlike, like again) is not mistaken for a duplicate; the
        // unique dedupeKey in MongoDB is what guarantees one notification.
        jobId: `${event.recipientId}-${dedupeKeyOf(event)}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: { count: 5_000 },
      });
    },
    close: () => queue.close(),
  };
}

export function createRecordingNotificationQueue(): NotificationQueue & {
  events: NotificationEvent[];
} {
  const events: NotificationEvent[] = [];
  return {
    events,
    enqueue: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}

/**
 * Notifications must never fail the action that caused them: a like succeeds even if Redis is down.
 * Enqueue errors are logged and dropped. (A transactional outbox would make them durable; see notes.)
 */
export function createNotifier({ queue, logger }: { queue: NotificationQueue; logger: Logger }) {
  return {
    notify(event: NotificationEvent): void {
      if (event.actorId === event.recipientId) return;
      queue
        .enqueue(event)
        .catch((err: unknown) => logger.warn({ err, type: event.type }, 'Notification not queued'));
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
