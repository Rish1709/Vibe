import { POST_TEXT_MAX, type PostDto } from '@vibe/shared';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  BookmarkIcon,
  CommentIcon,
  HeartIcon,
  MoreIcon,
  RepostIcon,
  ShareIcon,
} from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { useMe } from '@/features/account/api';
import { fullDate, timeAgo } from '@/lib/time';
import { useDeletePost, useTogglePost, useUpdatePost } from './api';
import { PostComposer } from './PostComposer';
import { PostMedia } from './PostMedia';
import { PostText } from './PostText';
import { QuotedPost, UnavailablePost } from './QuotedPost';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });

interface ActionProps {
  label: string;
  count?: number;
  active?: boolean;
  activeClass?: string;
  onClick?: () => void;
  children: ReactNode;
}

function Action({
  label,
  count,
  active = false,
  activeClass = 'text-accent',
  onClick,
  children,
}: ActionProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={onClick ? active : undefined}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      className={`group inline-flex items-center gap-1.5 rounded-full px-2 py-1.5 text-sm transition hover:bg-surface-hover ${
        active ? activeClass : 'text-muted hover:text-text'
      }`}
    >
      <span className="[&>svg]:size-[18px]">{children}</span>
      {count !== undefined && count > 0 && (
        <span className="tabular-nums">{compact.format(count)}</span>
      )}
    </button>
  );
}

function EditForm({ post, onDone }: { post: PostDto; onDone: () => void }) {
  const [text, setText] = useState(post.text);
  const update = useUpdatePost();
  const valid = text.trim().length > 0 && text.length <= POST_TEXT_MAX;
  return (
    <div className="mt-2">
      <label htmlFor={`edit-${post.id}`} className="sr-only">
        Edit post
      </label>
      <textarea
        id={`edit-${post.id}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={3}
        className="w-full rounded-xl border border-border bg-bg p-3 outline-none focus:border-accent"
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={!valid}
          loading={update.isPending}
          onClick={() =>
            update.mutate(
              { id: post.id, text: text.trim() },
              { onSuccess: onDone, onError: () => toast.error('Could not save your edit') },
            )
          }
        >
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * One post in any list. For a plain repost, the card shows the original post with a "reposted"
 * banner, and every action targets the original (which is what the API expects).
 */
export function PostCard({ post: item }: { post: PostDto }) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const like = useTogglePost('like');
  const bookmark = useTogglePost('bookmark');
  const repost = useTogglePost('repost');
  const remove = useDeletePost();
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [quoting, setQuoting] = useState(false);

  const isRepost = item.kind === 'repost';
  const post = isRepost ? item.sharedPost : item;

  if (!post) {
    return (
      <article className="border-b border-border px-4 py-3">
        <RepostBanner item={item} />
        <UnavailablePost />
      </article>
    );
  }

  const share = async () => {
    const url = `${window.location.origin}/p/${post.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const ownerItems: MenuItem[] = post.viewer.isAuthor
    ? [
        ...(post.kind !== 'repost' ? [{ label: 'Edit', onSelect: () => setEditing(true) }] : []),
        { label: 'Delete', danger: true, onSelect: () => setConfirmingDelete(true) },
      ]
    : [];

  return (
    <article className="border-b border-border px-4 py-3 transition-colors hover:bg-surface/50">
      {isRepost && <RepostBanner item={item} />}
      <div className="flex gap-3">
        <Link to={`/${post.author.username}`} className="shrink-0">
          <Avatar src={post.author.avatarUrl} name={post.author.displayName} />
        </Link>
        <div className="min-w-0 flex-1">
          <header className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[15px]">
              <Link
                to={`/${post.author.username}`}
                className="truncate font-semibold hover:underline"
              >
                {post.author.displayName}
              </Link>
              <span className="truncate text-muted">@{post.author.username}</span>
              <span className="text-muted">·</span>
              <Link
                to={`/p/${post.id}`}
                title={fullDate(post.createdAt)}
                className="text-muted hover:underline"
              >
                <time dateTime={post.createdAt}>{timeAgo(post.createdAt)}</time>
              </Link>
              {post.editedAt && <span className="text-xs text-muted">(edited)</span>}
            </div>
            {ownerItems.length > 0 && (
              <Menu
                label="Post options"
                trigger={<MoreIcon className="size-5" />}
                items={ownerItems}
              />
            )}
          </header>

          {editing ? (
            <EditForm post={post} onDone={() => setEditing(false)} />
          ) : (
            post.text && (
              <div className="mt-0.5">
                <PostText text={post.text} />
              </div>
            )
          )}
          <PostMedia media={post.media} />
          {post.kind === 'quote' &&
            (post.sharedPost ? <QuotedPost post={post.sharedPost} /> : <UnavailablePost />)}

          {confirmingDelete && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3 text-sm">
              <span>Delete this post? This can't be undone.</span>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  loading={remove.isPending}
                  onClick={() => remove.mutate(post.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
          )}

          <footer className="-ml-2 mt-1 flex max-w-md items-center justify-between">
            <Action
              label="Comments"
              count={post.counts.comments}
              onClick={() => void navigate(`/p/${post.id}`)}
            >
              <CommentIcon />
            </Action>
            <Menu
              label={post.viewer.reposted ? 'Undo repost or quote' : 'Repost or quote'}
              trigger={
                <span
                  className={`inline-flex items-center gap-1.5 text-sm ${post.viewer.reposted ? 'text-emerald-500' : ''}`}
                >
                  <RepostIcon className="size-[18px]" />
                  {post.counts.reposts > 0 && (
                    <span className="tabular-nums">{compact.format(post.counts.reposts)}</span>
                  )}
                </span>
              }
              items={[
                {
                  label: post.viewer.reposted ? 'Undo repost' : 'Repost',
                  onSelect: () => repost.mutate({ id: post.id, active: !post.viewer.reposted }),
                },
                { label: 'Quote', onSelect: () => setQuoting(true) },
              ]}
            />
            <Action
              label={post.viewer.liked ? 'Unlike' : 'Like'}
              count={post.counts.likes}
              active={post.viewer.liked}
              activeClass="text-pink-500"
              onClick={() => like.mutate({ id: post.id, active: !post.viewer.liked })}
            >
              <HeartIcon filled={post.viewer.liked} />
            </Action>
            <Action
              label={post.viewer.bookmarked ? 'Remove bookmark' : 'Bookmark'}
              active={post.viewer.bookmarked}
              onClick={() => bookmark.mutate({ id: post.id, active: !post.viewer.bookmarked })}
            >
              <BookmarkIcon filled={post.viewer.bookmarked} />
            </Action>
            <Action label="Copy link" onClick={() => void share()}>
              <ShareIcon />
            </Action>
          </footer>

          {quoting && me && (
            <div className="mt-2 rounded-2xl border border-border">
              <PostComposer
                me={me}
                quoted={post}
                placeholder="Add a comment"
                autoFocus
                onPosted={() => setQuoting(false)}
              />
              <div className="flex justify-end px-4 pb-3">
                <Button variant="ghost" onClick={() => setQuoting(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function RepostBanner({ item }: { item: PostDto }) {
  return (
    <p className="mb-1 ml-8 flex items-center gap-1.5 text-sm font-medium text-muted">
      <RepostIcon className="size-4" />
      <Link to={`/${item.author.username}`} className="hover:underline">
        {item.viewer.isAuthor ? 'You' : item.author.displayName} reposted
      </Link>
    </p>
  );
}

export function PostCardSkeleton() {
  return (
    <div aria-hidden="true" className="flex gap-3 border-b border-border px-4 py-4">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}
