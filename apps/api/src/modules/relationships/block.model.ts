import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

const blockSchema = new Schema(
  {
    blockerId: { type: Schema.Types.ObjectId, required: true },
    blockedId: { type: Schema.Types.ObjectId, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Unique per pair; also serves "whom did I block" lists (newest first via createdAt in the query).
blockSchema.index({ blockerId: 1, blockedId: 1 }, { unique: true });
// The reverse direction: "who blocked me", needed to hide content from people who blocked the viewer.
blockSchema.index({ blockedId: 1, blockerId: 1 });

export type BlockRecord = InferSchemaType<typeof blockSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};

export const BlockModel = model('Block', blockSchema);
