import { Queue } from 'bullmq';
import type { Redis } from '../../infra/redis.js';

/** One queue for housekeeping; jobs are told apart by name (see maintenance.processor.ts). */
export const MAINTENANCE_QUEUE = 'maintenance';
export const POST_CASCADE_JOB = 'post-cascade';
export const COUNTER_RECONCILE_JOB = 'counter-reconcile';
export const COUNTER_RECONCILE_EVERY_MS = 24 * 60 * 60 * 1000;

/** Producer side, used by API services. */
export interface MaintenanceQueue {
  /** Removes a deleted post's likes, bookmarks, comments and notifications in the background. */
  enqueuePostCascade(postId: string): Promise<void>;
  close(): Promise<void>;
}

export function createMaintenanceQueue(connection: Redis, prefix: string): MaintenanceQueue {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection, prefix });
  return {
    async enqueuePostCascade(postId) {
      await queue.add(
        POST_CASCADE_JOB,
        { postId },
        {
          jobId: `${POST_CASCADE_JOB}-${postId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 5_000 },
        },
      );
    },
    close: () => queue.close(),
  };
}

export function createRecordingMaintenanceQueue(): MaintenanceQueue & { cascades: string[] } {
  const cascades: string[] = [];
  return {
    cascades,
    enqueuePostCascade: (postId) => {
      cascades.push(postId);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}
