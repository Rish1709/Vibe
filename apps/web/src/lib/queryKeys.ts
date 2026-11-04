/**
 * Central query-key factory, so invalidation and cache updates target the same keys as reads.
 * Everything that contains PostDtos lives under ['posts', ...], which lets one optimistic update
 * (e.g. a like) patch the same post wherever it is cached: timelines, detail pages, bookmarks.
 */
export const queryKeys = {
  me: ['me'] as const,
  profile: (username: string) => ['profile', username.toLowerCase()] as const,
  usernameAvailability: (username: string) => ['username-availability', username] as const,

  posts: ['posts'] as const,
  post: (id: string) => ['posts', 'detail', id] as const,
  userPosts: (userId: string) => ['posts', 'user', userId] as const,
  bookmarks: ['posts', 'bookmarks'] as const,
  feed: ['posts', 'feed'] as const,

  comments: (postId: string) => ['comments', postId] as const,
  replies: (commentId: string) => ['replies', commentId] as const,

  followers: (userId: string) => ['followers', userId] as const,
  following: (userId: string) => ['following', userId] as const,
  likers: (postId: string) => ['likers', postId] as const,
  followRequests: ['follow-requests'] as const,
  storyTray: ['stories', 'tray'] as const,
  storyViewers: (storyId: string) => ['stories', 'viewers', storyId] as const,
  blocks: ['blocks'] as const,
  userSearch: (q: string) => ['search', 'users', q] as const,
};
