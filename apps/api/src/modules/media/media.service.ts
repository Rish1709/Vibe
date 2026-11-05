import {
  IMAGE_MAX_BYTES,
  MEDIA_RULES,
  mediaKindOf,
  POST_MEDIA_MAX,
  type CreateUploadInput,
  type MediaDto,
  type MediaPurpose,
  type UploadTicketDto,
} from '@vibe/shared';
import type { Types } from 'mongoose';
import { MediaProviderUnavailableError, type MediaProvider } from '../../infra/imagekit.js';
import type { Logger } from '../../infra/logger.js';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import type { AuthUser } from '../users/user.service.js';
import { MediaModel, type MediaRecord } from './media.model.js';

/** Snapshot embedded into posts and stories, so rendering them never needs a media lookup. */
export interface EmbeddedMedia {
  mediaId: Types.ObjectId;
  kind: 'image' | 'video';
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

type StoredMedia = Pick<EmbeddedMedia, 'mediaId' | 'kind' | 'url'> & {
  thumbnailUrl?: string | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
};

export function toMediaDto(media: StoredMedia): MediaDto {
  return {
    id: media.mediaId.toHexString(),
    kind: media.kind,
    url: media.url,
    thumbnailUrl: media.thumbnailUrl ?? null,
    width: media.width ?? null,
    height: media.height ?? null,
  };
}

const maxBytesFor = (purpose: MediaPurpose, kind: 'image' | 'video') =>
  kind === 'image'
    ? Math.min(IMAGE_MAX_BYTES, MEDIA_RULES[purpose].maxBytes)
    : MEDIA_RULES[purpose].maxBytes;

/** Under ImageKit, every user's uploads live under their own folder, per purpose. */
const folderFor = (userId: string, purpose: MediaPurpose) => `/vibe/users/${userId}/${purpose}`;

export type MediaService = ReturnType<typeof createMediaService>;

export function createMediaService({
  provider,
  logger,
}: {
  provider: MediaProvider | null;
  logger: Logger;
}) {
  function requireProvider(): MediaProvider {
    if (!provider) throw Errors.serviceUnavailable('Media uploads are not configured');
    return provider;
  }

  /** Rejects a stored file: deletes it from ImageKit (best effort) and forgets the upload. */
  async function reject(media: MediaRecord, fileId: string, reason: string): Promise<never> {
    logger.warn({ mediaId: media._id.toHexString(), fileId, reason }, 'Rejected uploaded file');
    await requireProvider()
      .deleteFile(fileId)
      .catch((err: unknown) => logger.warn({ err, fileId }, 'Could not delete rejected file'));
    await MediaModel.deleteOne({ _id: media._id, status: 'pending' });
    throw Errors.badRequest(`Upload rejected: ${reason}`);
  }

  return {
    /**
     * Step 1: authorize an upload. Validation here is from the client's declaration only (type, size)
     * and exists for fast feedback; completeUpload re-checks everything against the real stored file.
     */
    async createUpload(viewer: AuthUser, input: CreateUploadInput): Promise<UploadTicketDto> {
      const imageKit = requireProvider();
      const folder = folderFor(viewer.id, input.purpose);
      const media = await MediaModel.create({
        ownerId: viewer.id,
        purpose: input.purpose,
        kind: mediaKindOf(input.mimeType),
        folder,
      });
      const auth = imageKit.createUploadAuth();
      return {
        mediaId: media._id.toHexString(),
        uploadUrl: imageKit.uploadUrl,
        fields: {
          publicKey: auth.publicKey,
          signature: auth.signature,
          expire: auth.expire,
          token: auth.token,
          // The name ties the stored file back to this record; the folder scopes it to the user.
          fileName: media._id.toHexString(),
          folder,
          useUniqueFileName: 'false',
        },
      };
    },

    /**
     * Step 2: after the browser uploaded, verify what ImageKit actually stored. The upload signature only
     * proves we authorized *an* upload; the client chose the folder, name, type and size. So the file must
     * be named after this media id, sit in this user's folder, and have an allowed type and size.
     * Anything else is deleted and refused.
     */
    async completeUpload(viewer: AuthUser, mediaId: string, fileId: string): Promise<MediaDto> {
      const imageKit = requireProvider();
      const media = await MediaModel.findOne({
        _id: mediaId,
        ownerId: viewer.id,
        status: 'pending',
      }).lean<MediaRecord>();
      if (!media) throw Errors.notFound('Upload not found');

      let file;
      try {
        file = await imageKit.getFile(fileId);
      } catch (err) {
        // The record stays pending, so the client can simply call complete again.
        if (err instanceof MediaProviderUnavailableError) {
          logger.warn({ err, mediaId, fileId }, 'ImageKit unavailable while verifying upload');
          throw Errors.serviceUnavailable(
            'Could not verify your upload right now. Please try again.',
          );
        }
        throw err;
      }
      if (!file) throw Errors.badRequest('Uploaded file not found');

      const baseName = file.name.replace(/\.[^.]+$/, '');
      if (baseName !== mediaId) return reject(media, fileId, 'file does not belong to this upload');
      if (!file.filePath.startsWith(`${media.folder}/`)) {
        return reject(media, fileId, 'file is outside your upload folder');
      }
      const rules = MEDIA_RULES[media.purpose];
      if (!file.mimeType || !rules.mimeTypes.includes(file.mimeType)) {
        return reject(media, fileId, 'unsupported file type');
      }
      const kind = mediaKindOf(file.mimeType);
      if (kind !== media.kind)
        return reject(media, fileId, 'file type changed after authorization');
      if (file.size > maxBytesFor(media.purpose, kind))
        return reject(media, fileId, 'file is too large');

      let ready: MediaRecord | null;
      try {
        ready = await MediaModel.findOneAndUpdate(
          { _id: media._id, status: 'pending' },
          {
            $set: {
              status: 'ready',
              fileId: file.fileId,
              url: file.url,
              thumbnailUrl: file.thumbnailUrl,
              mimeType: file.mimeType,
              size: file.size,
              width: file.width,
              height: file.height,
            },
          },
          { returnDocument: 'after' },
        ).lean<MediaRecord>();
      } catch (err) {
        // The unique fileId index: someone is trying to register a file that already backs other media.
        if (isDuplicateKeyError(err)) throw Errors.conflict('This file is already in use');
        throw err;
      }
      if (!ready?.url) throw Errors.conflict('Upload was already completed');
      return toMediaDto({
        mediaId: ready._id,
        kind,
        url: ready.url,
        thumbnailUrl: ready.thumbnailUrl ?? null,
        ...pickDimensions(ready),
      });
    },

    /**
     * Atomically takes ownership of ready media for one post, story or avatar. Each id moves
     * ready -> attached with a conditional update, so two concurrent posts can never share a file. If any
     * id can't be claimed, the ones already claimed are put back and the request fails.
     */
    async claim(
      viewer: AuthUser,
      mediaIds: string[],
      purpose: MediaPurpose,
    ): Promise<EmbeddedMedia[]> {
      const unique = [...new Set(mediaIds)];
      if (unique.length !== mediaIds.length) throw Errors.badRequest('Each file can be used once');
      const claimed: MediaRecord[] = [];
      try {
        for (const id of unique) {
          const media = await MediaModel.findOneAndUpdate(
            { _id: id, ownerId: viewer.id, purpose, status: 'ready' },
            { $set: { status: 'attached', attachedAt: new Date() } },
            { returnDocument: 'after' },
          ).lean<MediaRecord>();
          if (!media?.url)
            throw Errors.badRequest('A file is missing, not finished uploading, or already used');
          claimed.push(media);
        }
        if (purpose === 'post') {
          const videos = claimed.filter((media) => media.kind === 'video').length;
          if (videos > 1 || (videos === 1 && claimed.length > 1)) {
            throw Errors.badRequest('A post can have one video, or up to 4 photos');
          }
          if (claimed.length > POST_MEDIA_MAX)
            throw Errors.badRequest('A post can have up to 4 photos');
        }
      } catch (err) {
        await MediaModel.updateMany(
          { _id: { $in: claimed.map((media) => media._id) }, status: 'attached' },
          { $set: { status: 'ready', attachedAt: null } },
        );
        throw err;
      }
      return claimed.map((media) => ({
        mediaId: media._id,
        kind: media.kind,
        url: media.url ?? '',
        thumbnailUrl: media.thumbnailUrl ?? null,
        ...pickDimensions(media),
      }));
    },

    /** Undoes a claim when the owning write failed, so the uploads can be used again. */
    async unclaim(mediaIds: Types.ObjectId[]): Promise<void> {
      if (mediaIds.length === 0) return;
      await MediaModel.updateMany(
        { _id: { $in: mediaIds }, status: 'attached' },
        { $set: { status: 'ready', attachedAt: null } },
      );
    },

    /** The owner (post, avatar) is gone: the cleanup job will delete the files. */
    async release(mediaIds: Types.ObjectId[]): Promise<void> {
      if (mediaIds.length === 0) return;
      await MediaModel.updateMany({ _id: { $in: mediaIds } }, { $set: { status: 'released' } });
    },
  };
}

function pickDimensions(media: Pick<MediaRecord, 'width' | 'height'>) {
  return { width: media.width ?? null, height: media.height ?? null };
}
