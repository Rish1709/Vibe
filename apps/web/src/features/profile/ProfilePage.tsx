import { useParams } from 'react-router';
import { LockIcon, SparkIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { ApiError } from '@/lib/apiClient';
import { useUserPosts } from '../posts/api';
import { PostList } from '../posts/PostList';
import { useProfile } from './api';
import { ProfileHeader, ProfileHeaderSkeleton } from './ProfileHeader';

export function ProfilePage() {
  const { username = '' } = useParams();
  const profile = useProfile(username);
  const posts = useUserPosts(profile.data?.id ?? '', profile.data?.canViewContent === true);

  if (profile.isPending) {
    return (
      <>
        <PageHeader title={`@${username}`} />
        <ProfileHeaderSkeleton />
      </>
    );
  }

  if (profile.isError) {
    const notFound = profile.error instanceof ApiError && profile.error.status === 404;
    return (
      <>
        <PageHeader title="Profile" />
        {notFound ? (
          <EmptyState title="This account doesn't exist" description="Try searching for another." />
        ) : (
          <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
        )}
      </>
    );
  }

  const { data } = profile;
  const isOwn = data.viewer === null;
  return (
    <>
      <PageHeader title={data.displayName} subtitle={`${data.counts.posts} posts`} />
      <ProfileHeader profile={data} />
      {data.viewer?.blocking ? (
        <EmptyState
          title={`You blocked @${data.username}`}
          description="Unblock them to see their posts."
        />
      ) : !data.canViewContent ? (
        <EmptyState
          icon={<LockIcon />}
          title="This account is private"
          description={
            data.viewer?.following === 'pending'
              ? 'Your follow request is waiting for approval.'
              : 'Follow this account to see their posts.'
          }
        />
      ) : (
        <PostList
          query={posts}
          empty={
            <EmptyState
              icon={<SparkIcon />}
              title="No posts yet"
              description={isOwn ? 'When you share something, it will show up here.' : undefined}
            />
          }
        />
      )}
    </>
  );
}
