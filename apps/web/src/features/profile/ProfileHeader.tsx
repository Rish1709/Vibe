import type { PublicProfileDto } from '@vibe/shared';
import { Link } from 'react-router';
import { CalendarIcon, LinkIcon, LockIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Skeleton';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });
const joined = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span>
      <strong className="font-semibold">{compact.format(value)}</strong>{' '}
      <span className="text-muted">{label}</span>
    </span>
  );
}

export function ProfileHeader({ profile, isOwn }: { profile: PublicProfileDto; isOwn: boolean }) {
  return (
    <section className="border-b border-border px-4 pt-6 pb-5">
      <div className="flex items-start justify-between gap-4">
        <Avatar src={profile.avatarUrl} name={profile.displayName} size="lg" />
        {isOwn && (
          <Link
            to="/settings"
            className="rounded-full border border-border px-4 py-1.5 text-sm font-semibold hover:bg-surface-hover"
          >
            Edit profile
          </Link>
        )}
      </div>

      <div className="mt-4">
        <h2 className="flex items-center gap-1.5 text-xl font-bold">
          {profile.displayName}
          {profile.isPrivate && (
            <LockIcon className="size-4 text-muted" aria-label="Private account" />
          )}
        </h2>
        <p className="text-muted">@{profile.username}</p>
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
        <Stat value={profile.counts.followers} label="followers" />
        <Stat value={profile.counts.following} label="following" />
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
