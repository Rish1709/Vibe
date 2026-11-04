import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll } from 'vitest';
import { createFanoutProcessor } from '../../src/modules/feed/fanout.processor.js';
import {
  createFeedQueue,
  FEED_FANOUT_QUEUE,
  type FeedQueue,
} from '../../src/modules/feed/feed.queue.js';
import { createTimelineStore } from '../../src/modules/feed/timeline.store.js';
import { silentLogger } from './testApp.js';

const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';

/**
 * A real BullMQ queue and worker running the production fan-out processor, on a per-file key prefix so
 * parallel test files never process each other's jobs. `drain()` waits until every queued job is done.
 */
export function useFeedWorker(redis: Redis) {
  const prefix = `test-${randomUUID().slice(0, 8)}`;
  const connections = [0, 1, 2].map(
    () => new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true }),
  );
  const [producerConn, inspectorConn, workerConn] = connections as [Redis, Redis, Redis];
  let queue: FeedQueue;
  let inspector: Queue;
  let worker: Worker;

  beforeAll(async () => {
    await Promise.all(connections.map((connection) => connection.connect()));
    queue = createFeedQueue(producerConn, prefix);
    inspector = new Queue(FEED_FANOUT_QUEUE, { connection: inspectorConn, prefix });
    worker = new Worker(
      FEED_FANOUT_QUEUE,
      createFanoutProcessor({ timeline: createTimelineStore(redis), logger: silentLogger }),
      { connection: workerConn, prefix, concurrency: 4 },
    );
  });

  afterAll(async () => {
    await worker.close();
    await inspector.obliterate({ force: true });
    await Promise.all([queue.close(), inspector.close()]);
    await Promise.all(connections.map((connection) => connection.quit()));
  });

  return {
    /** Forwards to the real queue (created in beforeAll). */
    queue: {
      enqueue: (job) => queue.enqueue(job),
      close: () => Promise.resolve(),
    } satisfies FeedQueue,
    async drain(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const counts = await inspector.getJobCounts('waiting', 'active', 'delayed', 'prioritized');
        if (Object.values(counts).every((n) => n === 0)) return;
        if (Date.now() > deadline)
          throw new Error(`Fan-out queue did not drain: ${JSON.stringify(counts)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async failedCount() {
      return (await inspector.getJobCounts('failed')).failed ?? 0;
    },
    async completedCount() {
      return (await inspector.getJobCounts('completed')).completed ?? 0;
    },
  };
}
