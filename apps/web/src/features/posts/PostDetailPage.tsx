import { useNavigate, useParams } from 'react-router';
import { BackIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { ApiError } from '@/lib/apiClient';
import { CommentSection } from '../comments/CommentSection';
import { usePost } from './api';
import { PostCard, PostCardSkeleton } from './PostCard';

export function PostDetailPage() {
  const { postId = '' } = useParams();
  const navigate = useNavigate();
  const post = usePost(postId);

  const header = (
    <PageHeader
      title="Post"
      action={
        <button
          type="button"
          aria-label="Back"
          onClick={() => void navigate(-1)}
          className="rounded-full p-2 hover:bg-surface-hover"
        >
          <BackIcon className="size-5" />
        </button>
      }
    />
  );

  if (post.isPending) {
    return (
      <>
        {header}
        <PostCardSkeleton />
      </>
    );
  }
  if (post.isError) {
    const missing = post.error instanceof ApiError && post.error.status === 404;
    return (
      <>
        {header}
        {missing ? (
          <EmptyState
            title="This post isn't available"
            description="It may have been deleted, or the account is private."
          />
        ) : (
          <ErrorState error={post.error} onRetry={() => void post.refetch()} />
        )}
      </>
    );
  }

  // Comments belong to the original, so a repost's thread is its shared post's thread.
  const threadId = post.data.kind === 'repost' ? post.data.sharedPost?.id : post.data.id;
  return (
    <>
      {header}
      <PostCard post={post.data} />
      {threadId && <CommentSection postId={threadId} />}
    </>
  );
}
