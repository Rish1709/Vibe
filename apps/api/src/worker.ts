import { Emitter } from '@socket.io/redis-emitter';
import type { ServerToClientEvents } from '@vibe/shared';
import { Queue, Worker } from 'bullmq';
import { parseEnv } from './config/env.js';
import { createMediaProviderFromEnv } from './infra/imagekit.js';
import { createLogger } from './infra/logger.js';
import { connectMongo, disconnectMongo } from './infra/mongo.js';
import { createRedisClient } from './infra/redis.js';
import { registerGracefulShutdown } from './lib/shutdown.js';
import { createFanoutProcessor } from './modules/feed/fanout.processor.js';
import { FEED_FANOUT_QUEUE } from './modules/feed/feed.queue.js';
import { createTimelineStore } from './modules/feed/timeline.store.js';
import { createCounterReconciler } from './modules/maintenance/counter.reconcile.js';
import { createMaintenanceProcessor } from './modules/maintenance/maintenance.processor.js';
import {
  COUNTER_RECONCILE_EVERY_MS,
  COUNTER_RECONCILE_JOB,
  MAINTENANCE_QUEUE,
} from './modules/maintenance/maintenance.queue.js';
import { createPostCascade } from './modules/maintenance/post.cascade.js';
import {
  createMediaCleanup,
  MEDIA_CLEANUP_EVERY_MS,
  MEDIA_CLEANUP_JOB,
} from './modules/media/media.cleanup.js';
import { createNotificationProcessor } from './modules/notifications/notification.processor.js';
import { NOTIFICATIONS_QUEUE } from './modules/notifications/notification.queue.js';
import { createEmitterPublisher } from './realtime/publisher.js';

/**
 * Background worker process, deployed and scaled separately from the API: a burst of fan-out work
 * never competes with request handling, and workers can be added without touching the API.
 * Any number of workers can run; BullMQ hands each job to exactly one of them at a time.
 */
const env = parseEnv(process.env);
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' }).child(
  {
    process: 'worker',
  },
);

const FANOUT_CONCURRENCY = 4;
const NOTIFICATION_CONCURRENCY = 8;

async function main(): Promise<void> {
  await connectMongo(env.MONGODB_URI, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    autoIndex: false,
    logger,
  });

  // BullMQ workers issue blocking commands: they need their own connection with unlimited retries.
  const queueRedis = createRedisClient(env.REDIS_URL, {
    name: 'worker-queue',
    logger,
    blocking: true,
  });
  const timelineRedis = createRedisClient(env.REDIS_URL, { name: 'worker-timelines', logger });
  await Promise.all([queueRedis.connect(), timelineRedis.connect()]);

  const worker = new Worker(
    FEED_FANOUT_QUEUE,
    createFanoutProcessor({ timeline: createTimelineStore(timelineRedis), logger }),
    { connection: queueRedis, prefix: env.QUEUE_PREFIX, concurrency: FANOUT_CONCURRENCY },
  );
  worker.on('failed', (job, err) => {
    logger.error({ err, jobId: job?.id, attempts: job?.attemptsMade }, 'Fan-out job failed');
  });
  worker.on('error', (err) => logger.error({ err }, 'Worker error'));
  logger.info({ queue: FEED_FANOUT_QUEUE, concurrency: FANOUT_CONCURRENCY }, 'Worker started');

  // Scheduled maintenance. upsertJobScheduler is idempotent, so every worker can declare the schedule
  // on startup and BullMQ still runs one job per interval across all of them.
  const mediaProvider = createMediaProviderFromEnv(env);
  const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
    connection: queueRedis,
    prefix: env.QUEUE_PREFIX,
  });
  if (mediaProvider) {
    await maintenanceQueue.upsertJobScheduler(
      MEDIA_CLEANUP_JOB,
      { every: MEDIA_CLEANUP_EVERY_MS },
      { name: MEDIA_CLEANUP_JOB },
    );
  } else {
    // Drops a schedule left over from a run that had ImageKit configured.
    await maintenanceQueue.removeJobScheduler(MEDIA_CLEANUP_JOB);
    logger.warn('ImageKit is not configured: media cleanup is disabled');
  }
  await maintenanceQueue.upsertJobScheduler(
    COUNTER_RECONCILE_JOB,
    { every: COUNTER_RECONCILE_EVERY_MS },
    { name: COUNTER_RECONCILE_JOB },
  );
  const maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE,
    createMaintenanceProcessor({
      mediaCleanup: mediaProvider ? createMediaCleanup({ provider: mediaProvider, logger }) : null,
      postCascade: createPostCascade({ logger }),
      reconcileCounters: createCounterReconciler({ logger }),
    }),
    // One at a time: these are bulk jobs, and the reconciler's two measurements assume no overlap.
    { connection: queueRedis, prefix: env.QUEUE_PREFIX, concurrency: 1 },
  );
  maintenanceWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id, job: job?.name }, 'Maintenance job failed'),
  );

  // The worker holds no sockets: it publishes pushes into Redis, and each API instance's Socket.IO
  // adapter delivers them to the sockets it holds.
  const realtime = createEmitterPublisher(new Emitter<ServerToClientEvents>(timelineRedis));
  const notificationWorker = new Worker(
    NOTIFICATIONS_QUEUE,
    createNotificationProcessor({ realtime, logger }),
    { connection: queueRedis, prefix: env.QUEUE_PREFIX, concurrency: NOTIFICATION_CONCURRENCY },
  );
  notificationWorker.on('failed', (job, err) =>
    logger.error({ err, jobId: job?.id, attempts: job?.attemptsMade }, 'Notification job failed'),
  );

  registerGracefulShutdown({
    logger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    steps: [
      // Stops taking new jobs and waits for active ones; unfinished jobs are retried by another worker.
      {
        name: 'worker',
        run: async () => {
          await Promise.all([
            worker.close(),
            notificationWorker.close(),
            maintenanceWorker.close(),
            maintenanceQueue.close(),
          ]);
        },
      },
      {
        name: 'redis',
        run: async () => {
          await Promise.all([queueRedis.quit(), timelineRedis.quit()]);
        },
      },
      { name: 'mongo', run: disconnectMongo },
    ],
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
