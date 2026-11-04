import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

export const POST_KINDS = ['original', 'repost', 'quote'] as const;

const postSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: POST_KINDS, required: true },
    /** Empty for plain reposts. */
    text: { type: String, default: '' },
    /** Lowercased, deduplicated, bounded (see extractHashtags), so the multikey index stays small. */
    hashtags: { type: [String], default: [] },
    /** The reposted or quoted post. Embedding a copy would go stale on edit; we reference and hydrate. */
    sharedPostId: { type: Schema.Types.ObjectId, default: null },
    /**
     * Denormalized counters. Reading them is O(1); counting the likes collection per render would be
     * O(likes) and dominate feed latency.
     */
    counts: {
      type: new Schema(
        {
          likes: { type: Number, default: 0 },
          comments: { type: Number, default: 0 },
          reposts: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },
    editedAt: { type: Date, default: null },
    /** Soft delete: hidden immediately; dependent likes/comments are cleaned up asynchronously. */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

// Profile timelines, and the per-author index ranges the chronological feed merges (Phase 5).
postSchema.index({ authorId: 1, createdAt: -1, _id: -1 });
// Hashtag pages / discovery (Phase 8).
postSchema.index({ hashtags: 1, createdAt: -1, _id: -1 });
// One plain repost per user per post. Reposts are hard-deleted on undo, so the constraint frees up.
postSchema.index(
  { authorId: 1, sharedPostId: 1 },
  { unique: true, partialFilterExpression: { kind: 'repost' } },
);
// "Did the viewer repost these?" batch lookups and repost counts.
postSchema.index({ sharedPostId: 1, kind: 1 });

export type PostRecord = InferSchemaType<typeof postSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const PostModel = model('Post', postSchema);
