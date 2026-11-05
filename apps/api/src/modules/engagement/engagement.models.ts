import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

/** One document per (post, user). Counting likes reads posts.counts.likes, never this collection. */
const likeSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// Uniqueness is what makes concurrent double-likes count once. It also answers "has the viewer liked
// these N posts?" as N point lookups ($in on postId + equality on userId), so no second index is
// needed for that; every extra index would add write cost to each like.
likeSchema.index({ postId: 1, userId: 1 }, { unique: true });
// Likers list, newest first.
likeSchema.index({ postId: 1, createdAt: -1, _id: -1 });

const bookmarkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    postId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
bookmarkSchema.index({ userId: 1, postId: 1 }, { unique: true });
// The viewer's saved posts, newest first.
bookmarkSchema.index({ userId: 1, createdAt: -1, _id: -1 });
// Cleanup when a post is deleted (the unique index leads with userId, so it can't serve this).
bookmarkSchema.index({ postId: 1 });

export type LikeRecord = InferSchemaType<typeof likeSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export type BookmarkRecord = InferSchemaType<typeof bookmarkSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const LikeModel = model('Like', likeSchema);
export const BookmarkModel = model('Bookmark', bookmarkSchema);
