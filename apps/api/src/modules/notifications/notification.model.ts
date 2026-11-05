import { NOTIFICATION_TYPES } from '@vibe/shared';
import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

/** Notifications are a convenience, not a record: they expire after 90 days. */
export const NOTIFICATION_TTL_SECONDS = 90 * 24 * 60 * 60;

const notificationSchema = new Schema(
  {
    recipientId: { type: Schema.Types.ObjectId, required: true },
    actorId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    postId: { type: Schema.Types.ObjectId, default: null },
    commentId: { type: Schema.Types.ObjectId, default: null },
    /**
     * Identifies the event (type, actor, target), unique per recipient: liking, unliking and liking
     * again, or a retried job, still leaves exactly one notification.
     */
    dedupeKey: { type: String, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

notificationSchema.index({ recipientId: 1, dedupeKey: 1 }, { unique: true });
// The notifications page: newest first (keyset on createdAt, _id).
notificationSchema.index({ recipientId: 1, createdAt: -1, _id: -1 });
// The unread badge, and "mark all read".
notificationSchema.index({ recipientId: 1, readAt: 1 });
// Cascades when a post or comment is deleted. Partial: most notifications are follows with no post.
notificationSchema.index(
  { postId: 1 },
  { partialFilterExpression: { postId: { $type: 'objectId' } } },
);
notificationSchema.index(
  { commentId: 1 },
  { partialFilterExpression: { commentId: { $type: 'objectId' } } },
);
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: NOTIFICATION_TTL_SECONDS });

export type NotificationRecord = InferSchemaType<typeof notificationSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const NotificationModel = model('Notification', notificationSchema);
