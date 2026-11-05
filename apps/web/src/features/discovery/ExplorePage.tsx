import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { SearchIcon } from '@/components/icons';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useFollowUser } from '../relationships/api';
import { FollowButton } from '../relationships/FollowButton';
import { UserRow } from '../relationships/UserList';
import { useSuggestions, useTrending } from './api';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });

function SectionTitle({ children }: { children: string }) {
  return <h2 className="px-4 pt-5 pb-2 text-lg font-bold">{children}</h2>;
}

function Loading({ rows }: { rows: number }) {
  return (
    <div className="space-y-3 px-4 py-2" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  );
}

function Trending() {
  const trending = useTrending();
  if (trending.isPending) return <Loading rows={4} />;
  if (trending.isError)
    return <ErrorState error={trending.error} onRetry={() => void trending.refetch()} />;
  if (trending.data.length === 0) {
    return (
      <p className="px-4 py-2 text-sm text-muted">
        Nothing is trending yet. Use a #hashtag in a post.
      </p>
    );
  }
  return (
    <ol aria-label="Trending hashtags" className="divide-y divide-border">
      {trending.data.map((item, index) => (
        <li key={item.tag}>
          <Link
            to={`/hashtag/${encodeURIComponent(item.tag)}`}
            className="block px-4 py-3 hover:bg-surface-hover"
          >
            <span className="block text-xs text-muted">{index + 1} · Trending this week</span>
            <span className="block font-semibold">#{item.tag}</span>
            <span className="block text-xs text-muted">
              {compact.format(item.authors)} {item.authors === 1 ? 'person' : 'people'} ·{' '}
              {compact.format(item.posts)} {item.posts === 1 ? 'post' : 'posts'}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

function WhoToFollow() {
  const suggestions = useSuggestions(5);
  const follow = useFollowUser();
  if (suggestions.isPending) return <Loading rows={3} />;
  if (suggestions.isError) {
    return <ErrorState error={suggestions.error} onRetry={() => void suggestions.refetch()} />;
  }
  if (suggestions.data.length === 0) {
    return <p className="px-4 py-2 text-sm text-muted">No suggestions right now.</p>;
  }
  return (
    <ul aria-label="Who to follow" className="divide-y divide-border">
      {suggestions.data.map((user) => (
        <UserRow
          key={user.id}
          user={user}
          note={
            user.mutuals > 0
              ? `Followed by ${user.mutuals} ${user.mutuals === 1 ? 'person' : 'people'} you follow`
              : undefined
          }
          action={
            user.viewer && (
              <FollowButton
                size="sm"
                state={user.viewer.following}
                pending={follow.isPending && follow.variables.userId === user.id}
                onChange={(next) => follow.mutate({ userId: user.id, follow: next })}
              />
            )
          }
        />
      ))}
    </ul>
  );
}

/** Search box, trending hashtags, and accounts to follow. */
export function ExplorePage() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = q.trim();
    if (trimmed) void navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  };

  return (
    <>
      <PageHeader title="Explore" />
      <form onSubmit={submit} className="border-b border-border px-4 py-3">
        <label className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 focus-within:border-accent">
          <SearchIcon className="size-5 shrink-0 text-muted" />
          <span className="sr-only">Search Vibe</span>
          <input
            type="search"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Search people and posts"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
        </label>
      </form>
      <SectionTitle>Trending</SectionTitle>
      <Trending />
      <SectionTitle>Who to follow</SectionTitle>
      <WhoToFollow />
    </>
  );
}
