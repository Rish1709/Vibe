import { z } from 'zod';
import { mediaIdsSchema, type MediaDto } from './media.js';
import { objectIdSchema } from './pagination.js';

export const POST_TEXT_MAX = 500;
export const COMMENT_TEXT_MAX = 300;
export const HASHTAGS_MAX = 10;

/** The viewer's relationship to another account, as returned with profiles and user lists. */
export type FollowState = 'none' | 'pending' | 'active';

export interface ViewerRelationship {
  /** Whether the viewer follows them (or has a pending request). */
  following: FollowState;
  /** Whether they follow the viewer. */
  followedBy: boolean;
  /** Whether the viewer has blocked them. */
  blocking: boolean;
}

/** Compact user shape embedded in posts, comments and user lists. */
export interface UserSummaryDto {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface UserListItemDto extends UserSummaryDto {
  /** Absent when the listed user is the viewer. */
  viewer?: { following: FollowState };
}

export interface FollowResultDto {
  following: FollowState;
}

export interface FollowRequestDto {
  id: string;
  user: UserSummaryDto;
  createdAt: string;
}

const postTextSchema = z.string().trim().min(1, 'Write something').max(POST_TEXT_MAX);

export const createPostSchema = z
  .object({
    text: postTextSchema.optional(),
    /** Uploaded media (see /media/uploads), up to 4 images or 1 video. */
    mediaIds: mediaIdsSchema.optional(),
    /** Quote another post. Plain reposts (no text) use PUT /posts/:id/repost. */
    quotedPostId: objectIdSchema.optional(),
  })
  .strict()
  .refine((value) => value.text !== undefined || (value.mediaIds?.length ?? 0) > 0, {
    message: 'Write something or add a photo or video',
    path: ['text'],
  });
export type CreatePostInput = z.infer<typeof createPostSchema>;

export const updatePostSchema = z.object({ text: postTextSchema }).strict();
export type UpdatePostInput = z.infer<typeof updatePostSchema>;

export const createCommentSchema = z
  .object({
    text: z.string().trim().min(1, 'Write a comment').max(COMMENT_TEXT_MAX),
    /** Reply to this comment. Replies to replies attach to the top-level comment. */
    parentId: objectIdSchema.optional(),
  })
  .strict();
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const idParamsSchema = z.object({ id: objectIdSchema });

export type PostKind = 'original' | 'repost' | 'quote';

export interface PostDto {
  id: string;
  kind: PostKind;
  author: UserSummaryDto;
  /** Empty for plain reposts. */
  text: string;
  hashtags: string[];
  media: MediaDto[];
  /**
   * The reposted or quoted post (one level deep). Null with `sharedPostUnavailable` when it was
   * deleted or the viewer may not see it.
   */
  sharedPost: PostDto | null;
  sharedPostUnavailable: boolean;
  counts: { likes: number; comments: number; reposts: number };
  viewer: {
    liked: boolean;
    bookmarked: boolean;
    reposted: boolean;
    isAuthor: boolean;
    /** Whether reposting or quoting is allowed (never for private accounts' posts). */
    canReshare: boolean;
  };
  createdAt: string;
  editedAt: string | null;
}

export interface CommentDto {
  id: string;
  postId: string;
  parentId: string | null;
  author: UserSummaryDto;
  text: string;
  counts: { replies: number };
  viewer: { canDelete: boolean };
  createdAt: string;
}

export interface ToggleResultDto {
  active: boolean;
  count: number;
}

export const USER_SEARCH_QUERY_MAX = 50;
export const USER_SEARCH_LIMIT_MAX = 25;

/** `q` matches a username prefix ("@" optional) or the start of any word in the display name. */
export const userSearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Type something to search').max(USER_SEARCH_QUERY_MAX),
  limit: z.coerce.number().int().min(1).max(USER_SEARCH_LIMIT_MAX).default(20),
});
export type UserSearchQuery = z.infer<typeof userSearchQuerySchema>;

export interface UserSearchResultDto extends UserListItemDto {
  /** Lets the client say up front that following sends a request. */
  isPrivate: boolean;
}
