import {
  usernameSchema,
  type MeDto,
  type OnboardingInput,
  type PublicProfileDto,
  type UpdateProfileInput,
  type UpdateSettingsInput,
  type UsernameAvailabilityDto,
} from '@vibe/shared';
import { z } from 'zod';
import { cacheAside, invalidate } from '../../cache/cacheAside.js';
import { CacheKeys } from '../../cache/keys.js';
import type { Logger } from '../../infra/logger.js';
import type { Redis } from '../../infra/redis.js';
import { Errors, isDuplicateKeyError } from '../../lib/errors.js';
import type { IdentityProfile, IdentityProvider } from './identity.js';
import { toMe, toPublicProfile } from './user.mapper.js';
import { UserModel, type UserRecord } from './user.model.js';

/** The minimal identity attached to every authenticated request. */
const authUserSchema = z.object({
  id: z.string(),
  clerkId: z.string(),
  username: z.string().nullable(),
  deleted: z.boolean(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/**
 * Short because invalidation is best-effort: if a DEL fails after a username change or deletion,
 * the stale entry is served for at most this long.
 */
const AUTH_USER_TTL_SECONDS = 300;
const DEFAULT_DISPLAY_NAME = 'New user';

interface UserServiceDeps {
  redis: Redis;
  logger: Logger;
  identity: IdentityProvider;
}

export type UserService = ReturnType<typeof createUserService>;

export function createUserService({ redis, logger, identity }: UserServiceDeps) {
  const toAuthUser = (user: UserRecord): AuthUser => ({
    id: user._id.toHexString(),
    clerkId: user.clerkId,
    username: user.username ?? null,
    deleted: user.deletedAt !== null,
  });

  const findByClerkId = (clerkId: string) => UserModel.findOne({ clerkId }).lean<UserRecord>();

  const invalidateAuthUser = (clerkId: string) =>
    invalidate(redis, logger, CacheKeys.authUser(clerkId));

  /**
   * Upserts identity fields from the provider, applying an event only if it is newer than the last
   * one applied. If the row exists but is newer (or deleted), the filter matches nothing, the upsert
   * attempts an insert, and the unique index on clerkId rejects it: that E11000 means "stale, ignore".
   * The same mechanism makes concurrent first-time provisioning safe: one insert wins.
   */
  async function applyIdentity(profile: IdentityProfile): Promise<'applied' | 'ignored'> {
    try {
      await UserModel.updateOne(
        {
          clerkId: profile.clerkId,
          deletedAt: null,
          $or: [{ clerkUpdatedAt: null }, { clerkUpdatedAt: { $lt: profile.updatedAt } }],
        },
        {
          $set: {
            email: profile.email,
            clerkImageUrl: profile.imageUrl,
            clerkUpdatedAt: profile.updatedAt,
          },
          // The display name is only seeded from the provider; afterwards the user owns it.
          $setOnInsert: { displayName: profile.name ?? DEFAULT_DISPLAY_NAME },
        },
        { upsert: true },
      );
      return 'applied';
    } catch (err) {
      if (isDuplicateKeyError(err)) return 'ignored';
      throw err;
    }
  }

  async function provision(clerkId: string): Promise<AuthUser> {
    let profile: IdentityProfile;
    try {
      profile = await identity.getUser(clerkId);
    } catch (err) {
      logger.error({ err, clerkId }, 'Identity provider lookup failed');
      throw Errors.serviceUnavailable('Unable to load your account right now. Please retry.');
    }
    await applyIdentity(profile);
    const user = await findByClerkId(clerkId);
    if (!user) throw Errors.internal(new Error(`Provisioning did not persist user ${clerkId}`));
    logger.info({ clerkId, userId: user._id.toHexString() }, 'User provisioned');
    return toAuthUser(user);
  }

  async function requireActiveUser(userId: string): Promise<UserRecord> {
    const user = await UserModel.findOne({ _id: userId, deletedAt: null }).lean<UserRecord>();
    if (!user) throw Errors.notFound('Account not found');
    return user;
  }

  return {
    applyIdentity,

    /**
     * Maps a verified Clerk user id to the local user on every authenticated request.
     * Cached because it is on the hot path; provisions the user on first sight so that sign-in
     * works even if the `user.created` webhook is delayed or never configured.
     */
    async resolveAuthUser(clerkId: string): Promise<AuthUser> {
      const cached = await cacheAside({
        redis,
        logger,
        key: CacheKeys.authUser(clerkId),
        ttlSeconds: AUTH_USER_TTL_SECONDS,
        schema: authUserSchema,
        load: async () => {
          const user = await findByClerkId(clerkId);
          return user ? toAuthUser(user) : null;
        },
      });
      return cached ?? provision(clerkId);
    },

    /**
     * Soft-deletes the account. If the user was never seen locally, a tombstone is inserted so a
     * `user.created` event delivered after `user.deleted` cannot create the account.
     */
    async markDeleted(clerkId: string, deletedAt: Date): Promise<void> {
      await UserModel.updateOne(
        { clerkId },
        {
          $set: { deletedAt, clerkUpdatedAt: deletedAt },
          $setOnInsert: { displayName: 'Deleted user' },
        },
        { upsert: true },
      );
      await invalidateAuthUser(clerkId);
      // Phase 4: enqueue cascade cleanup (follows, posts, likes) as an idempotent background job.
    },

    async getMe(user: AuthUser): Promise<MeDto> {
      return toMe(await requireActiveUser(user.id));
    },

    async getProfileByUsername(username: string): Promise<PublicProfileDto> {
      const user = await UserModel.findOne({ username, deletedAt: null }).lean<UserRecord>();
      if (!user?.username) throw Errors.notFound('User not found');
      return toPublicProfile({ ...user, username: user.username });
    },

    /**
     * Advisory only: the answer can be stale by the time the user submits (TOCTOU).
     * The unique index decides at claim time; this exists for instant form feedback.
     */
    async checkUsernameAvailability(raw: string, self: AuthUser): Promise<UsernameAvailabilityDto> {
      const parsed = usernameSchema.safeParse(raw);
      const normalized = raw.trim().toLowerCase();
      if (!parsed.success) {
        return {
          username: normalized,
          available: false,
          reason: parsed.error.issues[0]?.message ?? 'Invalid username',
        };
      }
      if (parsed.data === self.username) return { username: parsed.data, available: true };
      const taken = await UserModel.exists({ username: parsed.data });
      return { username: parsed.data, available: taken === null };
    },

    async completeOnboarding(user: AuthUser, input: OnboardingInput): Promise<MeDto> {
      if (user.username) throw Errors.conflict('Onboarding is already complete');
      let updated: UserRecord | null;
      try {
        // The username filter makes this a one-shot transition even under concurrent submits.
        updated = await UserModel.findOneAndUpdate(
          { _id: user.id, username: { $exists: false }, deletedAt: null },
          { $set: { username: input.username, displayName: input.displayName } },
          { returnDocument: 'after' },
        ).lean<UserRecord>();
      } catch (err) {
        if (isDuplicateKeyError(err)) throw Errors.usernameTaken();
        throw err;
      }
      if (!updated) throw Errors.conflict('Onboarding is already complete');
      await invalidateAuthUser(user.clerkId);
      return toMe(updated);
    },

    async updateProfile(user: AuthUser, input: UpdateProfileInput): Promise<MeDto> {
      const { website, ...rest } = input;
      const update = { ...rest, ...(website !== undefined && { website: website || null }) };
      let updated: UserRecord | null;
      try {
        updated = await UserModel.findOneAndUpdate(
          { _id: user.id, deletedAt: null },
          { $set: update },
          { returnDocument: 'after' },
        ).lean<UserRecord>();
      } catch (err) {
        if (isDuplicateKeyError(err)) throw Errors.usernameTaken();
        throw err;
      }
      if (!updated) throw Errors.notFound('Account not found');
      if (input.username !== undefined && input.username !== user.username) {
        await invalidateAuthUser(user.clerkId);
      }
      return toMe(updated);
    },

    async updateSettings(user: AuthUser, input: UpdateSettingsInput): Promise<MeDto> {
      const updated = await UserModel.findOneAndUpdate(
        { _id: user.id, deletedAt: null },
        { $set: input },
        { returnDocument: 'after' },
      ).lean<UserRecord>();
      if (!updated) throw Errors.notFound('Account not found');
      return toMe(updated);
    },
  };
}
