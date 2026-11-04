import { NavLink, useParams } from 'react-router';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { useProfile } from '../profile/api';
import { useFollowers, useFollowing } from './api';
import { UserList } from './UserList';

function Tabs({ username }: { username: string }) {
  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex-1 border-b-2 py-3 text-center text-sm font-semibold ${
      isActive ? 'border-accent text-text' : 'border-transparent text-muted hover:bg-surface-hover'
    }`;
  return (
    <nav aria-label="Connections" className="flex border-b border-border">
      <NavLink to={`/${username}/followers`} className={tab}>
        Followers
      </NavLink>
      <NavLink to={`/${username}/following`} className={tab}>
        Following
      </NavLink>
    </nav>
  );
}

// Separate components so only the visible list is fetched.
function Followers({ userId }: { userId: string }) {
  return <UserList query={useFollowers(userId)} empty={<EmptyState title="No followers yet" />} />;
}

function Following({ userId }: { userId: string }) {
  return (
    <UserList
      query={useFollowing(userId)}
      empty={<EmptyState title="Not following anyone yet" />}
    />
  );
}

export function FollowListPage({ kind }: { kind: 'followers' | 'following' }) {
  const { username = '' } = useParams();
  const profile = useProfile(username);

  return (
    <>
      <PageHeader title={profile.data?.displayName ?? `@${username}`} subtitle={`@${username}`} />
      <Tabs username={username} />
      {profile.isError ? (
        <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />
      ) : profile.data && !profile.data.canViewContent ? (
        <EmptyState title="This account is private" />
      ) : profile.data ? (
        kind === 'followers' ? (
          <Followers userId={profile.data.id} />
        ) : (
          <Following userId={profile.data.id} />
        )
      ) : null}
    </>
  );
}
