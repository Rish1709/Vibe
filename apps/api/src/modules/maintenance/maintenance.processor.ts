import type { Job } from 'bullmq';
import { z } from 'zod';
import { MEDIA_CLEANUP_JOB } from '../media/media.cleanup.js';
import { COUNTER_RECONCILE_JOB, POST_CASCADE_JOB } from './maintenance.queue.js';

const cascadeJobSchema = z.object({ postId: z.string().regex(/^[a-f\d]{24}$/i) });

/** Routes maintenance jobs by name. Every handler is idempotent, so BullMQ retries are safe. */
export function createMaintenanceProcessor({
  mediaCleanup,
  postCascade,
  reconcileCounters,
}: {
  /** Null when ImageKit isn't configured: there are no files to clean up. */
  mediaCleanup: (() => Promise<unknown>) | null;
  postCascade: (postId: string) => Promise<unknown>;
  reconcileCounters: () => Promise<unknown>;
}) {
  return async (job: Job): Promise<unknown> => {
    switch (job.name) {
      case MEDIA_CLEANUP_JOB:
        return mediaCleanup ? mediaCleanup() : { skipped: 'ImageKit is not configured' };
      case POST_CASCADE_JOB:
        return postCascade(cascadeJobSchema.parse(job.data).postId);
      case COUNTER_RECONCILE_JOB:
        return reconcileCounters();
      default:
        throw new Error(`Unknown maintenance job: ${job.name}`);
    }
  };
}
