import type { ProfileDto } from '@vibe/shared';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { CalendarIcon, LinkIcon, LockIcon, MessageIcon, MoreIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { Skeleton } from '@/components/ui/Skeleton';
import { useOpenConversation } from '../messages/api';
import { useBlock, useFollow } from '../relationships/api';
import { FollowButton } from '../relationships/FollowButton';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });
const joined = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

function Stat({ value, label, to }: { value: number; label: string; to?: string | undefined }) {
  const content = (
    <>
      <strong className="font-semibold">{compact.format(value)}</strong>{' '}
      <span className="text-muted">{label}</span>
    </>
  );
  return to ? (
    <Link to={to} className="hover:underline">
      {content}
    </Link>
  ) : (
    <span>{content}</span>
  );
}

function MessageButton({ userId }: { userId: string }) {
  const open = useOpenConversation();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      aria-label="Message"
      disabled={open.isPending}
      onClick={() =>
        open.mutate(userId, {
          onSuccess: (conversation) => void navigate(`/messages/${conversation.id}`),
          onError: () => toast.error('Could not open the conversation'),
        })
      }
      className="rounded-full border border-border p-2 hover:bg-surface-hover disabled:opacity-50"
    >
      <MessageIcon className="size-5" />
    </button>
  );
}

function ProfileActions({ profile }: { profile: ProfileDto }) {
  const follow = useFollow(profile);
  const block = useBlock(profile);
  if (!profile.viewer) {
    return (
      <Link
        to="/settings"
        className="rounded-full border border-border px-4 py-1.5 text-sm font-semibold hover:bg-surface-hover"
      >
        Edit profile
      </Link>
    );
  }
  const { blocking, following } = profile.viewer;
  return (
    <div className="flex items-center gap-1">
      <Menu
        label="More profile actions"
        trigger={<MoreIcon className="size-5" />}
        items={[
          blocking
            ? { label: `Unblock @${profile.username}`, onSelect: () => block.mutate(false) }
            : {
                label: `Block @${profile.username}`,
                danger: true,
                onSelect: () => block.mutate(true),
              },
        ]}
      />
      {profile.canMessage && <MessageButton userId={profile.id} />}
      {blocking ? (
        <Button variant="danger" loading={block.isPending} onClick={() => block.mutate(false)}>
          Unblock
        </Button>
      ) : (
        <FollowButton
          state={following}
          pending={follow.isPending}
          onChange={(next) => follow.mutate(next)}
        />
      )}
    </div>
  );
}

export function ProfileHeader({ profile }: { profile: ProfileDto }) {
  const listsVisible = profile.canViewContent;
  return (
    <section className="border-b border-border px-4 pt-6 pb-5">
      <div className="flex items-start justify-between gap-4">
        <Avatar src={profile.avatarUrl} name={profile.displayName} size="lg" />
        <ProfileActions profile={profile} />
      </div>

      <div className="mt-4">
        <h2 className="flex items-center gap-1.5 text-xl font-bold">
          {profile.displayName}
          {profile.isPrivate && (
            <LockIcon className="size-4 text-muted" aria-label="Private account" />
          )}
        </h2>
        <p className="flex items-center gap-2 text-muted">
          @{profile.username}
          {profile.viewer?.followedBy && (
            <span className="rounded bg-surface-hover px-1.5 py-0.5 text-xs">Follows you</span>
          )}
        </p>
      </div>

      {profile.bio && <p className="mt-3 whitespace-pre-line">{profile.bio}</p>}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
        {profile.website && (
          <a
            href={profile.website}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            <LinkIcon className="size-4" />
            {new URL(profile.website).host}
          </a>
        )}
        <span className="inline-flex items-center gap-1">
          <CalendarIcon className="size-4" />
          Joined {joined.format(new Date(profile.createdAt))}
        </span>
      </div>

      <div className="mt-3 flex gap-5 text-sm">
        <Stat value={profile.counts.posts} label="posts" />
        <Stat
          value={profile.counts.followers}
          label="followers"
          to={listsVisible ? `/${profile.username}/followers` : undefined}
        />
        <Stat
          value={profile.counts.following}
          label="following"
          to={listsVisible ? `/${profile.username}/following` : undefined}
        />
      </div>
    </section>
  );
}

export function ProfileHeaderSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Loading profile"
      className="border-b border-border px-4 pt-6 pb-5"
    >
      <Skeleton className="size-20 rounded-full sm:size-28" />
      <Skeleton className="mt-4 h-6 w-40" />
      <Skeleton className="mt-2 h-4 w-24" />
      <Skeleton className="mt-4 h-4 w-full max-w-sm" />
      <Skeleton className="mt-4 h-4 w-56" />
    </section>
  );
}
