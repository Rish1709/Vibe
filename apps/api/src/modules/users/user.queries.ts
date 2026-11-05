import type { UserSummaryDto } from '@vibe/shared';
import { Types, type ClientSession } from 'mongoose';
import { Errors } from '../../lib/errors.js';
import { UserModel, type UserRecord } from './user.model.js';

const SUMMARY_PROJECTION = { username: 1, displayName: 1, avatarUrl: 1, clerkImageUrl: 1 } as const;

type SummarySource = Pick<UserRecord, '_id' | 'displayName' | 'avatarUrl' | 'clerkImageUrl'> & {
  username?: string | null;
};

export function toUserSummary(user: SummarySource): UserSummaryDto {
  return {
    id: user._id.toHexString(),
    username: user.username ?? '',
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? user.clerkImageUrl ?? null,
  };
}

/**
 * Batch-loads summaries for active, onboarded users in one `$in` query (the N+1 fix for lists).
 * Deleted or not-yet-onboarded accounts are simply absent from the map; callers drop those rows.
 */
export async function findUserSummaries(
  ids: Iterable<string>,
): Promise<Map<string, UserSummaryDto>> {
  const unique = [...new Set(ids)].map((id) => new Types.ObjectId(id));
  if (unique.length === 0) return new Map();
  const users = await UserModel.find(
    { _id: { $in: unique }, deletedAt: null, username: { $type: 'string' } },
    SUMMARY_PROJECTION,
  ).lean<SummarySource[]>();
  return new Map(users.map((user) => [user._id.toHexString(), toUserSummary(user)]));
}

export interface AuthorInfo {
  summary: UserSummaryDto;
  isPrivate: boolean;
}

/** The visibility policy's view of a user already in hand (no query). */
export const toAuthorInfo = (user: SummarySource & { isPrivate: boolean }): AuthorInfo => ({
  summary: toUserSummary(user),
  isPrivate: user.isPrivate,
});

/** Like findUserSummaries, plus the privacy flag the visibility policy needs. */
export async function findAuthors(ids: Iterable<string>): Promise<Map<string, AuthorInfo>> {
  const unique = [...new Set(ids)].map((id) => new Types.ObjectId(id));
  if (unique.length === 0) return new Map();
  const users = await UserModel.find(
    { _id: { $in: unique }, deletedAt: null, username: { $type: 'string' } },
    { ...SUMMARY_PROJECTION, isPrivate: 1 },
  ).lean<(SummarySource & { isPrivate: boolean })[]>();
  return new Map(users.map((user) => [user._id.toHexString(), toAuthorInfo(user)]));
}

/** Loads an active, onboarded user or throws 404. */
export async function requireActiveUser(id: string): Promise<UserRecord & { username: string }> {
  const user = await UserModel.findOne({
    _id: id,
    deletedAt: null,
    username: { $type: 'string' },
  }).lean<UserRecord & { username: string }>();
  if (!user) throw Errors.notFound('User not found');
  return user;
}

/**
 * Applies a follow edge's effect on both counters. Called by whichever operation inserted (+1) or
 * deleted (-1) an active edge, never both, which keeps counters correct under concurrent follow,
 * unfollow and block without a transaction on the (potentially very hot) followee document.
 */
export async function adjustFollowCounts(
  followerId: string | Types.ObjectId,
  followeeId: string | Types.ObjectId,
  delta: 1 | -1,
  session?: ClientSession,
): Promise<void> {
  await UserModel.bulkWrite(
    [
      {
        updateOne: { filter: { _id: followerId }, update: { $inc: { 'counts.following': delta } } },
      },
      {
        updateOne: { filter: { _id: followeeId }, update: { $inc: { 'counts.followers': delta } } },
      },
    ],
    { ordered: false, ...(session && { session }) },
  );
}
