import { MESSAGE_POLICIES } from '@vibe/shared';
import { model, Schema, type InferSchemaType, type Types } from 'mongoose';

const userSchema = new Schema(
  {
    /** Clerk owns identity (credentials, sessions, email); Vibe owns the social profile. */
    clerkId: { type: String, required: true },
    email: { type: String, default: null },

    /** Lowercase, unique. Absent until onboarding, so the unique index is sparse. */
    username: { type: String },
    displayName: { type: String, required: true },
    /** Normalized words of displayName for indexed prefix search (see user.search.ts). */
    searchTokens: { type: [String], default: [] },
    bio: { type: String, default: '' },
    website: { type: String, default: null },
    /** Uploaded avatar (Phase 6). Falls back to the image from the identity provider. */
    avatarUrl: { type: String, default: null },
    avatarMediaId: { type: Schema.Types.ObjectId, default: null },
    clerkImageUrl: { type: String, default: null },

    isPrivate: { type: Boolean, default: false },
    messagePolicy: { type: String, enum: MESSAGE_POLICIES, default: 'everyone' },

    /**
     * Denormalized counters, so a profile renders without counting edge collections
     * (an O(followers) scan for popular accounts). Maintained with atomic $inc.
     */
    counts: {
      type: new Schema(
        {
          followers: { type: Number, default: 0 },
          following: { type: Number, default: 0 },
          posts: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({}),
    },

    /**
     * `updated_at` of the newest identity-provider event applied. Webhooks can be delivered
     * out of order and more than once; older events are ignored instead of overwriting newer data.
     */
    clerkUpdatedAt: { type: Date, default: null },
    /** Soft delete: the row stays as a tombstone so late webhooks cannot resurrect the account. */
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

userSchema.index({ clerkId: 1 }, { unique: true });
// Authoritative username uniqueness. An application-level "is it taken?" check alone would race.
// Sparse, not partial: users have no username until onboarding, so those documents must be left out.
// A partial index ({ $type: 'string' }) enforced that too, but the planner only uses a partial index
// when it can prove the query matches the filter, and it does not infer that `username = 'x'`
// implies a string. Every profile lookup became a COLLSCAN (found with explain() on seeded data).
userSchema.index({ username: 1 }, { unique: true, sparse: true });

// Multikey index: one entry per name word, so '^hop' finds 'Grace Hopper' with a range scan.
userSchema.index({ searchTokens: 1 });

type UserSchemaFields = InferSchemaType<typeof userSchema>;

/** Fields added after accounts existed are optional: `.lean()` reads don't apply schema defaults. */
export type UserRecord = Omit<UserSchemaFields, 'searchTokens'> & {
  searchTokens?: string[];
  _id: Types.ObjectId;
};

export const UserModel = model('User', userSchema);
