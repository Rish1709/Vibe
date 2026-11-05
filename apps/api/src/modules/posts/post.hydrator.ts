import type { PostDto, UserSummaryDto } from '@vibe/shared';
import { Types } from 'mongoose';
import { canReshare, canViewContent } from '../../policies/visibility.js';
import { BookmarkModel, LikeModel } from '../engagement/engagement.models.js';
import { toMediaDto } from '../media/media.service.js';
import { getRelationships } from '../relationships/relationship.service.js';
import { findAuthors } from '../users/user.queries.js';
import { PostModel, type PostRecord } from './post.model.js';

const hex = (id: Types.ObjectId) => id.toHexString();
// Counters are adjusted outside transactions, so one can be briefly negative under a race.
const nonNegative = (value: number) => Math.max(0, value);

/**
 * Turns post records into response DTOs for one viewer, in a constant number of queries regardless
 * of page size: shared posts, authors, relationships (3), and the viewer's likes, bookmarks and reposts.
 * Visibility is re-checked here, so callers (profile pages, bookmarks, and the feed's cached id lists
 * in Phase 5) can never leak a post whose author has since gone private, blocked the viewer, or
 * been deleted. Posts that fail the check are dropped; unavailable shared posts are flagged.
 */
export async function hydratePosts(viewerId: string, posts: PostRecord[]): Promise<PostDto[]> {
  if (posts.length === 0) return [];
  const viewer = new Types.ObjectId(viewerId);

  const sharedIds = posts.flatMap((post) => (post.sharedPostId ? [post.sharedPostId] : []));
  const shared = sharedIds.length
    ? await PostModel.find({ _id: { $in: sharedIds }, deletedAt: null }).lean<PostRecord[]>()
    : [];
  const sharedById = new Map(shared.map((post) => [hex(post._id), post]));

  const all = [...posts, ...shared];
  const authorIds = all.map((post) => hex(post.authorId));
  const [authors, relationships] = await Promise.all([
    findAuthors(authorIds),
    getRelationships(viewerId, authorIds),
  ]);

  /** The author's summary if the viewer may see this post, otherwise null. */
  const visibleAuthor = (post: PostRecord): UserSummaryDto | null => {
    const author = authors.get(hex(post.authorId));
    const rel = relationships.get(hex(post.authorId));
    return author && rel && canViewContent(rel, author) ? author.summary : null;
  };

  /** Same rule the repost and quote endpoints enforce, so the UI only offers what will succeed. */
  const mayReshare = (post: PostRecord): boolean => {
    const author = authors.get(hex(post.authorId));
    const rel = relationships.get(hex(post.authorId));
    return author !== undefined && rel !== undefined && canReshare(rel, author);
  };

  const visibleIds = all.filter((post) => visibleAuthor(post) !== null).map((post) => post._id);
  const [likes, bookmarks, reposts] = await Promise.all([
    LikeModel.find({ userId: viewer, postId: { $in: visibleIds } }, { postId: 1 }).lean(),
    BookmarkModel.find({ userId: viewer, postId: { $in: visibleIds } }, { postId: 1 }).lean(),
    PostModel.find(
      { authorId: viewer, kind: 'repost', sharedPostId: { $in: visibleIds } },
      { sharedPostId: 1 },
    ).lean(),
  ]);
  const liked = new Set(likes.map((like) => hex(like.postId)));
  const bookmarked = new Set(bookmarks.map((bookmark) => hex(bookmark.postId)));
  const reposted = new Set(
    reposts.flatMap((post) => (post.sharedPostId ? [hex(post.sharedPostId)] : [])),
  );

  const toDto = (
    post: PostRecord,
    author: UserSummaryDto,
    sharedPost: PostDto | null,
    sharedPostUnavailable: boolean,
  ): PostDto => {
    const id = hex(post._id);
    return {
      id,
      kind: post.kind,
      author,
      text: post.text,
      hashtags: post.hashtags,
      media: (post.media ?? []).map((media) => toMediaDto(media)),
      sharedPost,
      sharedPostUnavailable,
      counts: {
        likes: nonNegative(post.counts.likes),
        comments: nonNegative(post.counts.comments),
        reposts: nonNegative(post.counts.reposts),
      },
      viewer: {
        liked: liked.has(id),
        bookmarked: bookmarked.has(id),
        reposted: reposted.has(id),
        isAuthor: post.authorId.equals(viewer),
        canReshare: mayReshare(post),
      },
      createdAt: post.createdAt.toISOString(),
      editedAt: post.editedAt?.toISOString() ?? null,
    };
  };

  return posts.flatMap((post) => {
    const author = visibleAuthor(post);
    if (!author) return [];
    if (!post.sharedPostId) return [toDto(post, author, null, false)];
    const target = sharedById.get(hex(post.sharedPostId));
    const targetAuthor = target ? visibleAuthor(target) : null;
    // One level deep: a quoted post's own quote is not expanded.
    return [
      target && targetAuthor
        ? toDto(post, author, toDto(target, targetAuthor, null, false), false)
        : toDto(post, author, null, true),
    ];
  });
}
