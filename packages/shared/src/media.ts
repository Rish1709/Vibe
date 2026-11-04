import { z } from 'zod';
import { objectIdSchema } from './pagination.js';

export const MEDIA_PURPOSES = ['post', 'story', 'avatar'] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
export type MediaKind = 'image' | 'video';

const MB = 1024 * 1024;

/**
 * Allowed types and size ceilings per purpose. Enforced twice: when the upload is authorized (from the
 * client's declaration) and again when it is attached (from ImageKit's own record of the stored file),
 * because the client controls what it actually uploads.
 */
export const MEDIA_RULES: Record<MediaPurpose, { mimeTypes: readonly string[]; maxBytes: number }> =
  {
    post: {
      mimeTypes: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'video/mp4',
        'video/webm',
        'video/quicktime',
      ],
      maxBytes: 100 * MB,
    },
    story: {
      mimeTypes: [
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/webm',
        'video/quicktime',
      ],
      maxBytes: 50 * MB,
    },
    avatar: { mimeTypes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * MB },
  };
/** Images are capped lower than videos within each purpose. */
export const IMAGE_MAX_BYTES = 10 * MB;
export const POST_MEDIA_MAX = 4;

export const mediaKindOf = (mimeType: string): MediaKind =>
  mimeType.startsWith('video/') ? 'video' : 'image';

export const createUploadSchema = z
  .object({
    purpose: z.enum(MEDIA_PURPOSES),
    mimeType: z.string().max(100),
    size: z.number().int().positive(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const rules = MEDIA_RULES[value.purpose];
    if (!rules.mimeTypes.includes(value.mimeType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mimeType'],
        message: `Unsupported file type for a ${value.purpose}`,
      });
    }
    const max =
      mediaKindOf(value.mimeType) === 'image'
        ? Math.min(IMAGE_MAX_BYTES, rules.maxBytes)
        : rules.maxBytes;
    if (value.size > max) {
      ctx.addIssue({
        code: 'custom',
        path: ['size'],
        message: `File is too large (max ${Math.round(max / MB)} MB)`,
      });
    }
  });
export type CreateUploadInput = z.infer<typeof createUploadSchema>;

export const completeUploadSchema = z.object({ fileId: z.string().min(1).max(100) }).strict();

/** What the browser needs to upload directly to ImageKit. The private key never leaves the server. */
export interface UploadTicketDto {
  mediaId: string;
  uploadUrl: string;
  fields: {
    publicKey: string;
    signature: string;
    expire: string;
    token: string;
    fileName: string;
    folder: string;
    useUniqueFileName: 'false';
  };
}

export interface MediaDto {
  id: string;
  kind: MediaKind;
  url: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
}

export const mediaIdsSchema = z.array(objectIdSchema).max(POST_MEDIA_MAX);

export const STORY_CAPTION_MAX = 200;
export const STORY_TTL_HOURS = 24;

export const createStorySchema = z
  .object({
    mediaId: objectIdSchema,
    caption: z.string().trim().max(STORY_CAPTION_MAX).optional(),
  })
  .strict();
export type CreateStoryInput = z.infer<typeof createStorySchema>;

export interface StoryDto {
  id: string;
  media: MediaDto;
  caption: string | null;
  createdAt: string;
  expiresAt: string;
  viewer: { seen: boolean; isAuthor: boolean };
  /** Only for the author. */
  viewCount: number | null;
}

/** One ring in the story tray: an author and their active stories, oldest first (playback order). */
export interface StoryGroupDto {
  author: { id: string; username: string; displayName: string; avatarUrl: string | null };
  stories: StoryDto[];
  hasUnseen: boolean;
}
