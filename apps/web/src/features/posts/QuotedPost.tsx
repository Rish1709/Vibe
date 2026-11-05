import type { PostDto } from '@vibe/shared';
import { Link } from 'react-router';
import { Avatar } from '@/components/ui/Avatar';
import { timeAgo } from '@/lib/time';
import { PostMedia } from './PostMedia';
import { PostText } from './PostText';

/** The embedded card shown inside a quote post (and in the quote composer). */
export function QuotedPost({ post }: { post: PostDto }) {
  return (
    <Link
      to={`/p/${post.id}`}
      className="mt-2 block rounded-2xl border border-border p-3 transition hover:bg-surface"
    >
      <div className="flex items-center gap-2 text-sm">
        <Avatar src={post.author.avatarUrl} name={post.author.displayName} size="sm" />
        <span className="font-semibold">{post.author.displayName}</span>
        <span className="text-muted">
          @{post.author.username} · {timeAgo(post.createdAt)}
        </span>
      </div>
      {post.text && (
        <div className="mt-1 line-clamp-4">
          <PostText text={post.text} linkify={false} />
        </div>
      )}
      <PostMedia media={post.media.slice(0, 1)} />
    </Link>
  );
}

export function UnavailablePost() {
  return (
    <div className="mt-2 rounded-2xl border border-border bg-surface p-3 text-sm text-muted">
      This post is unavailable.
    </div>
  );
}
