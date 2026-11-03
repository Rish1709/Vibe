import type { MeDto, PublicProfileDto } from '@vibe/shared';
import type { UserRecord } from './user.model.js';

export function toPublicProfile(user: UserRecord & { username: string }): PublicProfileDto {
  return {
    id: user._id.toHexString(),
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    website: user.website ?? null,
    avatarUrl: user.avatarUrl ?? user.clerkImageUrl ?? null,
    isPrivate: user.isPrivate,
    counts: {
      followers: user.counts.followers,
      following: user.counts.following,
      posts: user.counts.posts,
    },
    createdAt: user.createdAt.toISOString(),
  };
}

export function toMe(user: UserRecord): MeDto {
  return {
    ...toPublicProfile({ ...user, username: user.username ?? '' }),
    username: user.username ?? null,
    email: user.email ?? null,
    onboarded: typeof user.username === 'string',
    settings: { messagePolicy: user.messagePolicy },
  };
}
