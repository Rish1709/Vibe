import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

const storySchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, required: true },
    media: {
      type: new Schema(
        {
          mediaId: { type: Schema.Types.ObjectId, required: true },
          kind: { type: String, enum: ['image', 'video'], required: true },
          url: { type: String, required: true },
          thumbnailUrl: { type: String, default: null },
          width: { type: Number, default: null },
          height: { type: Number, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    caption: { type: String, default: null },
    /**
     * Expiry is enforced by every query (`expiresAt > now`), not by the TTL index: MongoDB's TTL monitor
     * runs about once a minute and can lag further under load, so relying on it would show stories past
     * their 24 hours. The TTL index is only garbage collection.
     */
    expiresAt: { type: Date, required: true },
    viewCount: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Physical cleanup once expired. expireAfterSeconds 0 = delete at (or shortly after) expiresAt.
storySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// The tray and a profile's stories: equality on author ($in over followees), then expiresAt as both the
// range and the sort, with _id as the tie-breaker, so results stream in index order (a merge for $in).
storySchema.index({ authorId: 1, expiresAt: 1, _id: 1 });

const storyViewSchema = new Schema(
  {
    storyId: { type: Schema.Types.ObjectId, required: true },
    viewerId: { type: Schema.Types.ObjectId, required: true },
    /** Copied from the story, so views expire with it. */
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// One view per viewer per story: re-watching doesn't inflate the count, under concurrency too.
storyViewSchema.index({ storyId: 1, viewerId: 1 }, { unique: true });
// "Who viewed my story", newest first.
storyViewSchema.index({ storyId: 1, createdAt: -1, _id: -1 });
// "Which of these stories have I seen?" for the tray's unseen rings.
storyViewSchema.index({ viewerId: 1, storyId: 1 });
storyViewSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type StoryRecord = InferSchemaType<typeof storySchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export type StoryViewRecord = InferSchemaType<typeof storyViewSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const StoryModel = model('Story', storySchema);
export const StoryViewModel = model('StoryView', storyViewSchema);
