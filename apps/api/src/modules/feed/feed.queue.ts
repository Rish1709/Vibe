import { Queue } from 'bullmq';
import { z } from 'zod';
import type { Redis } from '../../infra/redis.js';

export const FEED_FANOUT_QUEUE = 'feed-fanout';

export const fanoutJobSchema = z.object({
  action: z.enum(['publish', 'remove']),
  postId: z.string(),
  authorId: z.string(),
  /** createdAt in epoch ms: the timeline score. */
  t: z.number(),
});
export type FanoutJob = z.infer<typeof fanoutJobSchema>;

/** Boundary to the job system, so services and tests don't depend on BullMQ directly. */
export interface FeedQueue {
  enqueue(job: FanoutJob): Promise<void>;
  close(): Promise<void>;
}

export function createFeedQueue(connection: Redis, prefix: string): FeedQueue {
  const queue = new Queue<FanoutJob>(FEED_FANOUT_QUEUE, { connection, prefix });
  return {
    async enqueue(job) {
      await queue.add(job.action, job, {
        // Deterministic id: enqueueing the same event twice (e.g. a client retry) creates one job.
        // (BullMQ rejects ":" in custom ids; it uses ":" as its own key separator.)
        jobId: `${job.action}-${job.postId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        // Keep recent history for debugging without growing Redis forever.
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      });
    },
    close: () => queue.close(),
  };
}

/** For tests and processes that publish nothing: records jobs instead of sending them. */
export function createRecordingFeedQueue(): FeedQueue & { jobs: FanoutJob[] } {
  const jobs: FanoutJob[] = [];
  return {
    jobs,
    enqueue: (job) => {
      jobs.push(job);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}
