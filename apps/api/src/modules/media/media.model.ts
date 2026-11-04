import { MEDIA_PURPOSES } from '@vibe/shared';
import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * One uploaded file's lifecycle:
 *   pending  - upload authorized, nothing verified yet
 *   ready    - ImageKit confirmed the stored file matches what was authorized
 *   attached - used by exactly one post, story or avatar (the ready -> attached transition is atomic)
 *   released - its owner (post, avatar) is gone; the cleanup job deletes the file
 * Anything left pending or ready for a day was abandoned and is cleaned up too.
 */
const mediaSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    purpose: { type: String, enum: MEDIA_PURPOSES, required: true },
    kind: { type: String, enum: ['image', 'video'], required: true },
    status: {
      type: String,
      enum: ['pending', 'ready', 'attached', 'released'],
      required: true,
      default: 'pending',
    },
    /** ImageKit folder this upload must land in; checked against the stored file's path. */
    folder: { type: String, required: true },
    fileId: { type: String },
    url: { type: String, default: null },
    thumbnailUrl: { type: String, default: null },
    mimeType: { type: String, default: null },
    size: { type: Number, default: null },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    attachedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// A stored file can back at most one media record (no claiming someone else's upload).
mediaSchema.index({ fileId: 1 }, { unique: true, sparse: true });
// The cleanup job's scans: abandoned uploads by age, released files, expired story media.
mediaSchema.index({ status: 1, createdAt: 1 });
mediaSchema.index({ purpose: 1, status: 1, attachedAt: 1 });

export type MediaRecord = InferSchemaType<typeof mediaSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const MediaModel = model('Media', mediaSchema);
