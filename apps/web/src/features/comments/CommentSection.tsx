import { COMMENT_TEXT_MAX, type CommentDto } from '@vibe/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiError } from '@/lib/apiClient';
import { timeAgo } from '@/lib/time';
import { useInfiniteScroll } from '@/lib/useInfiniteScroll';
import { useComments, useCreateComment, useDeleteComment, useReplies } from './api';

function CommentForm({
  postId,
  parentId,
  placeholder,
  onDone,
}: {
  postId: string;
  parentId?: string;
  placeholder: string;
  onDone?: () => void;
}) {
  const [text, setText] = useState('');
  const create = useCreateComment(postId);
  const valid = text.trim().length > 0 && text.length <= COMMENT_TEXT_MAX;

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        create.mutate(
          { text: text.trim(), ...(parentId && { parentId }) },
          {
            onSuccess: () => {
              setText('');
              onDone?.();
            },
            onError: (error) =>
              toast.error(error instanceof ApiError ? error.message : 'Could not comment'),
          },
        );
      }}
    >
      <label className="sr-only" htmlFor={`comment-${parentId ?? postId}`}>
        {placeholder}
      </label>
      <input
        id={`comment-${parentId ?? postId}`}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholder}
        maxLength={COMMENT_TEXT_MAX}
        className="min-w-0 flex-1 rounded-full border border-border bg-bg px-4 py-2 text-sm outline-none focus:border-accent"
      />
      <Button type="submit" disabled={!valid} loading={create.isPending} className="px-4 py-1.5">
        Reply
      </Button>
    </form>
  );
}

function CommentItem({ comment, postId }: { comment: CommentDto; postId: string }) {
  const [showReplies, setShowReplies] = useState(false);
  const [replying, setReplying] = useState(false);
  const remove = useDeleteComment(postId);
  const isTopLevel = comment.parentId === null;

  return (
    <li className="flex gap-3">
      <Link to={`/${comment.author.username}`} className="shrink-0">
        <Avatar src={comment.author.avatarUrl} name={comment.author.displayName} size="sm" />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          <Link to={`/${comment.author.username}`} className="font-semibold hover:underline">
            {comment.author.username}
          </Link>{' '}
          <span className="break-words whitespace-pre-line">{comment.text}</span>
        </p>
        <div className="mt-1 flex gap-4 text-xs text-muted">
          <time dateTime={comment.createdAt}>{timeAgo(comment.createdAt)}</time>
          <button
            type="button"
            className="font-semibold hover:text-text"
            onClick={() => setReplying((v) => !v)}
          >
            Reply
          </button>
          {comment.viewer.canDelete && (
            <button
              type="button"
              className="font-semibold hover:text-danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate(comment)}
            >
              Delete
            </button>
          )}
        </div>
        {replying && (
          <div className="mt-2">
            <CommentForm
              postId={postId}
              parentId={comment.parentId ?? comment.id}
              placeholder={`Reply to @${comment.author.username}`}
              onDone={() => {
                setReplying(false);
                setShowReplies(true);
              }}
            />
          </div>
        )}
        {isTopLevel && comment.counts.replies > 0 && (
          <button
            type="button"
            className="mt-2 text-xs font-semibold text-muted hover:text-text"
            onClick={() => setShowReplies((v) => !v)}
          >
            {showReplies
              ? 'Hide replies'
              : `View ${comment.counts.replies} ${comment.counts.replies === 1 ? 'reply' : 'replies'}`}
          </button>
        )}
        {isTopLevel && showReplies && <Replies commentId={comment.id} postId={postId} />}
      </div>
    </li>
  );
}

function Replies({ commentId, postId }: { commentId: string; postId: string }) {
  const replies = useReplies(commentId, true);
  if (replies.isPending) return <Skeleton className="mt-3 h-8 w-2/3" />;
  if (replies.isError) return <p className="mt-2 text-xs text-danger">Couldn't load replies.</p>;
  return (
    <>
      <ul className="mt-3 space-y-3">
        {replies.data.pages.flatMap((page) =>
          page.items.map((reply) => <CommentItem key={reply.id} comment={reply} postId={postId} />),
        )}
      </ul>
      {replies.hasNextPage && (
        <button
          type="button"
          className="mt-2 text-xs font-semibold text-muted hover:text-text"
          onClick={() => void replies.fetchNextPage()}
        >
          More replies
        </button>
      )}
    </>
  );
}

export function CommentSection({ postId }: { postId: string }) {
  const comments = useComments(postId);
  const sentinel = useInfiniteScroll(() => {
    if (comments.hasNextPage && !comments.isFetchingNextPage) void comments.fetchNextPage();
  }, comments.hasNextPage);

  return (
    <section aria-label="Comments" className="px-4 py-4">
      <CommentForm postId={postId} placeholder="Add a comment…" />
      <div className="mt-5">
        {comments.isPending ? (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : comments.isError ? (
          <ErrorState error={comments.error} onRetry={() => void comments.refetch()} />
        ) : comments.data.pages[0]?.items.length === 0 ? (
          <EmptyState title="No comments yet" description="Start the conversation." />
        ) : (
          <ul className="space-y-5">
            {comments.data.pages.flatMap((page) =>
              page.items.map((comment) => (
                <CommentItem key={comment.id} comment={comment} postId={postId} />
              )),
            )}
          </ul>
        )}
        <div ref={sentinel} />
      </div>
    </section>
  );
}
