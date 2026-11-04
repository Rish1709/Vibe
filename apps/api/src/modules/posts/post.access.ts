import { Errors } from '../../lib/errors.js';
import { canViewContent } from '../../policies/visibility.js';
import { getRelationship, type Relationship } from '../relationships/relationship.service.js';
import { requireActiveUser } from '../users/user.queries.js';
import type { UserRecord } from '../users/user.model.js';
import { PostModel, type PostRecord } from './post.model.js';

export interface VisiblePost {
  post: PostRecord;
  author: UserRecord & { username: string };
  rel: Relationship;
}

/**
 * Loads a post the viewer is allowed to see, or throws 404. Not-allowed and nonexistent look the same
 * on purpose: a 403 would confirm that a private or blocked account's post exists.
 * Every post-scoped endpoint (likes, comments, reposts, bookmarks) goes through this.
 */
export async function loadVisiblePost(viewerId: string, postId: string): Promise<VisiblePost> {
  const post = await PostModel.findOne({ _id: postId, deletedAt: null }).lean<PostRecord>();
  if (!post) throw Errors.notFound('Post not found');
  let author: VisiblePost['author'];
  try {
    author = await requireActiveUser(post.authorId.toHexString());
  } catch {
    throw Errors.notFound('Post not found');
  }
  const rel = await getRelationship(viewerId, author._id.toHexString());
  if (!canViewContent(rel, author)) throw Errors.notFound('Post not found');
  return { post, author, rel };
}
