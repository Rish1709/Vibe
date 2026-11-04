import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * One document per directed edge. A separate collection, not `followers: []` on the user:
 * popular accounts would grow an unbounded array toward the 16 MB document limit, and every
 * follow would rewrite that hot document.
 */
const followSchema = new Schema(
  {
    followerId: { type: Schema.Types.ObjectId, required: true },
    followeeId: { type: Schema.Types.ObjectId, required: true },
    /** `pending` until a private account approves the request. */
    status: { type: String, enum: ['pending', 'active'], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// At most one edge per pair: makes follow idempotent under concurrent requests.
followSchema.index({ followerId: 1, followeeId: 1 }, { unique: true });
// "Who follows X" (followers list, follow requests) in newest-first order.
followSchema.index({ followeeId: 1, status: 1, createdAt: -1, _id: -1 });
// "Who does X follow" (following list, and the feed's author set in Phase 5).
followSchema.index({ followerId: 1, status: 1, createdAt: -1, _id: -1 });

export type FollowRecord = InferSchemaType<typeof followSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const FollowModel = model('Follow', followSchema);
