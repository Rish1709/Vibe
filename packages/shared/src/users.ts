import { z } from 'zod';
import { objectIdSchema } from './pagination.js';
import type { ViewerRelationship } from './social.js';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;
export const DISPLAY_NAME_MAX = 50;
export const BIO_MAX = 160;

/**
 * Usernames double as profile URLs (`/:username`), so app routes must never be claimable.
 * Keep this in sync with top-level frontend routes.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'api',
  'app',
  'auth',
  'bookmarks',
  'explore',
  'feed',
  'help',
  'home',
  'login',
  'logout',
  'me',
  'messages',
  'moderator',
  'notifications',
  'onboarding',
  'post',
  'posts',
  'privacy',
  'root',
  'search',
  'settings',
  'sign-in',
  'sign-up',
  'signin',
  'signup',
  'stories',
  'support',
  'system',
  'terms',
  'vibe',
  'www',
]);

/**
 * Lowercase letters, digits, underscores and dots; no leading, trailing or consecutive dots.
 * Normalized to lowercase so "Alice" and "alice" can never be two accounts.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(USERNAME_MIN, `Must be at least ${USERNAME_MIN} characters`)
  .max(USERNAME_MAX, `Must be at most ${USERNAME_MAX} characters`)
  .regex(/^[a-z0-9_.]+$/, 'Use only letters, numbers, underscores and dots')
  .refine((value) => !/^\.|\.$|\.\./.test(value), 'Dots cannot be at the start, end, or repeated')
  .refine((value) => !RESERVED_USERNAMES.has(value), 'This username is reserved');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(DISPLAY_NAME_MAX, `Must be at most ${DISPLAY_NAME_MAX} characters`);

export const bioSchema = z.string().trim().max(BIO_MAX, `Must be at most ${BIO_MAX} characters`);

export const websiteSchema = z
  .url({ protocol: /^https?$/, message: 'Must be an http(s) URL' })
  .max(200);

export const MESSAGE_POLICIES = ['everyone', 'following'] as const;
export type MessagePolicy = (typeof MESSAGE_POLICIES)[number];

export const onboardingSchema = z
  .object({ username: usernameSchema, displayName: displayNameSchema })
  .strict();
export type OnboardingInput = z.infer<typeof onboardingSchema>;

export const updateProfileSchema = z
  .object({
    username: usernameSchema,
    displayName: displayNameSchema,
    bio: bioSchema,
    // Empty string clears the field.
    website: z.union([websiteSchema, z.literal('')]),
    /** An uploaded avatar (purpose 'avatar'), or null to remove the custom avatar. */
    avatarMediaId: objectIdSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updateSettingsSchema = z
  .object({
    isPrivate: z.boolean(),
    messagePolicy: z.enum(MESSAGE_POLICIES),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one setting to update');
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;

export const usernameParamsSchema = z.object({
  username: z.string().trim().toLowerCase().max(USERNAME_MAX),
});
export const usernameAvailabilityQuerySchema = z.object({ username: z.string().max(100) });

/** What anyone allowed to see the profile receives. */
export interface PublicProfileDto {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  website: string | null;
  avatarUrl: string | null;
  isPrivate: boolean;
  counts: { followers: number; following: number; posts: number };
  createdAt: string;
}

/** A profile as seen by a specific viewer. `viewer` is null on the viewer's own profile. */
export interface ProfileDto extends PublicProfileDto {
  viewer: ViewerRelationship | null;
  /** False for private accounts the viewer doesn't follow, and for blocked accounts. */
  canViewContent: boolean;
  /** Whether the viewer may message them (their message policy, blocks). False on your own profile. */
  canMessage: boolean;
}

/** The signed-in user's own account. Includes private fields. */
export interface MeDto extends Omit<PublicProfileDto, 'username'> {
  /** Null until onboarding claims a username. */
  username: string | null;
  email: string | null;
  onboarded: boolean;
  settings: { messagePolicy: MessagePolicy };
}

export interface UsernameAvailabilityDto {
  username: string;
  available: boolean;
  /** Present when unavailable because the name is invalid or reserved (not merely taken). */
  reason?: string;
}
