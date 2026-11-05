import type { MediaProvider } from '../../infra/imagekit.js';
import type { Logger } from '../../infra/logger.js';
import { MediaModel } from './media.model.js';

export { MAINTENANCE_QUEUE } from '../maintenance/maintenance.queue.js';
export const MEDIA_CLEANUP_JOB = 'media-cleanup';
export const MEDIA_CLEANUP_EVERY_MS = 60 * 60 * 1000;

const ABANDONED_AFTER_MS = 24 * 3600 * 1000;
/** Story media outlives its story a little, so a viewer mid-playback at expiry doesn't hit a 404. */
const STORY_MEDIA_KEPT_MS = 48 * 3600 * 1000;
const BATCH = 200;

/**
 * Deletes media files nobody owns any more:
 * - uploads abandoned before being attached (pending or ready for a day),
 * - files released by a deleted post, a replaced avatar or a deleted story,
 * - story media well past the story's 24 hours.
 *
 * Idempotent and restartable: each record is deleted only after its file is gone (a 404 from the CDN
 * counts as gone), so a crash or retry just picks the remainder up next run. Records whose file delete
 * fails stay put and are retried next hour.
 */
export function createMediaCleanup({
  provider,
  logger,
}: {
  provider: MediaProvider;
  logger: Logger;
}) {
  return async (now = new Date()): Promise<{ deleted: number; failed: number }> => {
    const candidates = await MediaModel.find(
      {
        $or: [
          {
            status: { $in: ['pending', 'ready'] },
            createdAt: { $lt: new Date(now.getTime() - ABANDONED_AFTER_MS) },
          },
          { status: 'released' },
          {
            purpose: 'story',
            status: 'attached',
            attachedAt: { $lt: new Date(now.getTime() - STORY_MEDIA_KEPT_MS) },
          },
        ],
      },
      { fileId: 1 },
    )
      .limit(BATCH)
      .lean();

    let deleted = 0;
    let failed = 0;
    for (const media of candidates) {
      try {
        if (media.fileId) await provider.deleteFile(media.fileId);
        await MediaModel.deleteOne({ _id: media._id });
        deleted++;
      } catch (err) {
        failed++;
        logger.warn({ err, mediaId: media._id.toHexString() }, 'Media cleanup failed; will retry');
      }
    }
    if (deleted || failed) logger.info({ deleted, failed }, 'Media cleanup run');
    return { deleted, failed };
  };
}
