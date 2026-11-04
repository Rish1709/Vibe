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
    /**
     * Embedded snapshot (bounded: at most 4 images or 1 video). Embedding is right here: media is always
     * read with its post and never changes after upload, so a separate lookup would only add a query.
     */
    media: {
      type: [
        new Schema(
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
      ],
      default: [],
    },
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
    /**
     * Set when the author was a celebrity at publish time, so the post was not pushed to followers'
     * timelines. Readers pull exactly these posts. Recording the decision on the post (rather than
     * re-deriving celebrity status at read time) stays correct when an author crosses the threshold in
     * either direction. Absent on ordinary posts.
     */
    fanoutSkipped: { type: Boolean },
    editedAt: { type: Date, default: null },
    /** Soft delete: hidden immediately; dependent likes/comments are cleaned up asynchronously. */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

// Profile timelines, and the per-author index ranges the chronological feed merges (Phase 5).
postSchema.index({ authorId: 1, createdAt: -1, _id: -1 });
// Celebrity posts merged into feeds at read time. Partial: holds only the (rare) unfanned posts, so
// the per-followee range seeks of the merge are cheap even for large followings.
postSchema.index(
  { fanoutSkipped: 1, authorId: 1, createdAt: -1, _id: -1 },
  { partialFilterExpression: { fanoutSkipped: true } },
);
// Hashtag pages / discovery (Phase 8).
postSchema.index({ hashtags: 1, createdAt: -1, _id: -1 });
// One plain repost per user per post. Reposts are hard-deleted on undo, so the constraint frees up.
postSchema.index(
  { authorId: 1, sharedPostId: 1 },
  { unique: true, partialFilterExpression: { kind: 'repost' } },
);
// "Did the viewer repost these?" batch lookups and repost counts.
postSchema.index({ sharedPostId: 1, kind: 1 });

type PostSchemaFields = InferSchemaType<typeof postSchema>;

/**
 * `.lean()` reads skip schema defaults, so a field added after posts already existed is simply absent
 * on older documents. Such fields are typed optional so every reader has to handle the missing case.
 */
export type PostRecord = Omit<PostSchemaFields, 'media'> & {
  media?: PostSchemaFields['media'];
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

export const PostModel = model('Post', postSchema);
