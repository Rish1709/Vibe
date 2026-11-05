import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

/**
 * One document per pair of users. `key` is the two ids sorted and joined, with a unique index, so
 * "open a conversation with X" is an upsert that two concurrent calls can't turn into two threads.
 *
 * Per-participant state (unread count, read position) lives in the `members` array: a conversation
 * has exactly two, so the array is tiny and each update targets one element with arrayFilters.
 */
const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    unread: { type: Number, default: 0 },
    lastReadAt: { type: Date, default: null },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    key: { type: String, required: true },
    participants: { type: [Schema.Types.ObjectId], required: true },
    members: { type: [memberSchema], required: true },
    /** Denormalized for the inbox, so listing conversations needs no message lookups. */
    lastMessage: {
      type: new Schema(
        {
          id: { type: Schema.Types.ObjectId, required: true },
          senderId: { type: Schema.Types.ObjectId, required: true },
          text: { type: String, required: true },
          createdAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    /** Null until the first message: empty conversations stay out of the inbox. */
    lastMessageAt: { type: Date, default: null },
  },
  { timestamps: true },
);

conversationSchema.index({ key: 1 }, { unique: true });
// The inbox: a user's conversations, most recent activity first (keyset on lastMessageAt, _id).
conversationSchema.index({ participants: 1, lastMessageAt: -1, _id: -1 });
// Unread badge: conversations where this user has unread messages.
conversationSchema.index({ 'members.userId': 1, 'members.unread': 1 });

export type ConversationRecord = InferSchemaType<typeof conversationSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const ConversationModel = model('Conversation', conversationSchema);

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, required: true },
    senderId: { type: Schema.Types.ObjectId, required: true },
    text: { type: String, required: true },
    clientId: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// A thread, newest first (keyset on createdAt, _id).
messageSchema.index({ conversationId: 1, createdAt: -1, _id: -1 });
// Idempotent sends: a retried request with the same clientId finds the original message.
messageSchema.index({ senderId: 1, clientId: 1 }, { unique: true });
// "Has the recipient written in this conversation?" (the reply exception to message policies).
messageSchema.index({ conversationId: 1, senderId: 1 });

export type MessageRecord = InferSchemaType<typeof messageSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const MessageModel = model('Message', messageSchema);

export const conversationKey = (a: string, b: string) => [a, b].sort().join('_');
