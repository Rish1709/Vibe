/** Central query-key factory, so invalidation and cache updates target the same keys as reads. */
export const queryKeys = {
  me: ['me'] as const,
  profile: (username: string) => ['profile', username.toLowerCase()] as const,
  usernameAvailability: (username: string) => ['username-availability', username] as const,
};
