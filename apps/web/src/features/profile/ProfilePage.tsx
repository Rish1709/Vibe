import { useParams } from 'react-router';
import { LockIcon, SparkIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { ApiError } from '@/lib/apiClient';
import { useMe } from '../account/api';
import { useProfile } from './api';
import { ProfileHeader, ProfileHeaderSkeleton } from './ProfileHeader';

export function ProfilePage() {
  const { username = '' } = useParams();
  const profile = useProfile(username);
  const me = useMe();

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

  const isOwn = me.data?.id === profile.data.id;
  return (
    <>
      <PageHeader
        title={profile.data.displayName}
        subtitle={`${profile.data.counts.posts} posts`}
      />
      <ProfileHeader profile={profile.data} isOwn={isOwn} />
      {profile.data.isPrivate && !isOwn ? (
        <EmptyState
          icon={<LockIcon />}
          title="This account is private"
          description="Follow this account to see their posts."
        />
      ) : (
        <EmptyState
          icon={<SparkIcon />}
          title="No posts yet"
          description={isOwn ? 'When you share something, it will show up here.' : undefined}
        />
      )}
    </>
  );
}
