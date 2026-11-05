import { USER_SEARCH_QUERY_MAX } from '@vibe/shared';
import { useSearchParams } from 'react-router';
import { SearchIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useDebouncedValue } from '@/lib/useDebouncedValue';
import { usePostSearch } from '../discovery/api';
import { PostList } from '../posts/PostList';
import { useFollowUser } from '../relationships/api';
import { FollowButton } from '../relationships/FollowButton';
import { UserRow } from '../relationships/UserList';
import { SEARCH_DEBOUNCE_MS, useUserSearch } from './api';

type Tab = 'people' | 'posts';

function Searching() {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Searching">
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-12" />
      ))}
    </div>
  );
}

function PeopleResults({ q }: { q: string }) {
  const search = useUserSearch(q);
  const follow = useFollowUser();
  const results = search.data ?? [];
  const hasQuery = q.length > 0;

  if (search.isError) {
    return <ErrorState error={search.error} onRetry={() => void search.refetch()} />;
  }
  if (!hasQuery || (search.isPending && results.length === 0)) return <Searching />;
  if (results.length === 0) {
    return (
      <EmptyState
        title={`No one matches “${q}”`}
        description="Check the spelling or try a shorter search."
      />
    );
  }
  return (
    <ul aria-label="People" className="divide-y divide-border">
      {results.map((user) => (
        <UserRow
          key={user.id}
          user={user}
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

function PostResults({ q }: { q: string }) {
  const posts = usePostSearch(q);
  if (!q) return <Searching />;
  return (
    <PostList
      query={posts}
      empty={
        <EmptyState
          title={`No posts match “${q}”`}
          description="Posts must contain every word. Try fewer words, or a #hashtag."
        />
      }
    />
  );
}

/** Search people (by name or @username) and posts (every word, or a #hashtag). */
export function SearchPage() {
  // The query and tab live in the URL, so going back keeps them and results can be linked.
  const [params, setParams] = useSearchParams();
  const typed = params.get('q') ?? '';
  const tab: Tab = params.get('type') === 'posts' ? 'posts' : 'people';
  // Debounced here, where it is always mounted: one request per pause in typing, for either tab.
  const q = useDebouncedValue(typed.trim(), SEARCH_DEBOUNCE_MS);

  const update = (next: { q?: string; tab?: Tab }) => {
    const q = next.q ?? typed;
    const type = next.tab ?? tab;
    setParams(
      { ...(q && { q }), ...(type === 'posts' && { type }) },
      { replace: true, preventScrollReset: true },
    );
  };

  return (
    <>
      <PageHeader title="Search" />
      <div className="border-b border-border px-4 pt-3">
        <label className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 focus-within:border-accent">
          <SearchIcon className="size-5 shrink-0 text-muted" />
          <span className="sr-only">Search people</span>
          <input
            type="search"
            value={typed}
            onChange={(event) => update({ q: event.target.value })}
            placeholder={
              tab === 'posts' ? 'Search posts or a #hashtag' : 'Search by name or @username'
            }
            maxLength={USER_SEARCH_QUERY_MAX}
            autoFocus
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
        </label>
        <div role="tablist" aria-label="Search results" className="mt-2 flex">
          {(['people', 'posts'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => update({ tab: value })}
              className={`flex-1 border-b-2 py-2.5 text-sm font-semibold capitalize ${
                tab === value ? 'border-accent text-text' : 'border-transparent text-muted'
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {!typed.trim() ? (
        <EmptyState
          icon={<SearchIcon />}
          title={tab === 'posts' ? 'Find posts' : 'Find people'}
          description={
            tab === 'posts'
              ? 'Posts containing every word you type, newest first. Or search a #hashtag.'
              : 'Search by name or @username. Private accounts get a follow request they can approve.'
          }
        />
      ) : tab === 'posts' ? (
        <PostResults q={q} />
      ) : (
        <PeopleResults q={q} />
      )}
    </>
  );
}
