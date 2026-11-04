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
import {
  createMediaCleanup,
  MAINTENANCE_QUEUE,
  MEDIA_CLEANUP_EVERY_MS,
  MEDIA_CLEANUP_JOB,
} from './modules/media/media.cleanup.js';

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
  let maintenanceWorker: Worker | null = null;
  if (mediaProvider) {
    const cleanup = createMediaCleanup({ provider: mediaProvider, logger });
    await maintenanceQueue.upsertJobScheduler(
      MEDIA_CLEANUP_JOB,
      { every: MEDIA_CLEANUP_EVERY_MS },
      { name: MEDIA_CLEANUP_JOB },
    );
    maintenanceWorker = new Worker(MAINTENANCE_QUEUE, () => cleanup(), {
      connection: queueRedis,
      prefix: env.QUEUE_PREFIX,
      concurrency: 1,
    });
    maintenanceWorker.on('failed', (job, err) =>
      logger.error({ err, jobId: job?.id }, 'Maintenance job failed'),
    );
  } else {
    logger.warn('ImageKit is not configured: media cleanup is disabled');
  }

  registerGracefulShutdown({
    logger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    steps: [
      // Stops taking new jobs and waits for active ones; unfinished jobs are retried by another worker.
      {
        name: 'worker',
        run: async () => {
          await Promise.all([worker.close(), maintenanceWorker?.close(), maintenanceQueue.close()]);
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
