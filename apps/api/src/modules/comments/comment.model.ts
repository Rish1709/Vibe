import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * Two levels: top-level comments (parentId null) and replies (parentId = the top-level comment).
 * A reply to a reply attaches to the same top-level comment. Bounding depth keeps every thread query
 * a single indexed range scan, instead of a recursive tree walk ($graphLookup) per page.
 */
const commentSchema = new Schema(
  {
    postId: { type: Schema.Types.ObjectId, required: true },
    authorId: { type: Schema.Types.ObjectId, required: true },
    parentId: { type: Schema.Types.ObjectId, default: null },
    text: { type: String, required: true },
    counts: {
      type: new Schema({ replies: { type: Number, default: 0 } }, { _id: false }),
      required: true,
      default: () => ({}),
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

// Top-level comments of a post, newest first: equality on (postId, parentId = null), then the sort.
commentSchema.index({ postId: 1, parentId: 1, createdAt: -1, _id: -1 });
// Replies of a comment, oldest first (conversation order).
commentSchema.index({ parentId: 1, createdAt: 1, _id: 1 });

export type CommentRecord = InferSchemaType<typeof commentSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const CommentModel = model('Comment', commentSchema);
