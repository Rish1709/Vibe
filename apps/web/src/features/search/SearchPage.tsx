import { USER_SEARCH_QUERY_MAX } from '@vibe/shared';
import { useSearchParams } from 'react-router';
import { SearchIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton } from '@/components/ui/Skeleton';
import { useFollowUser } from '../relationships/api';
import { FollowButton } from '../relationships/FollowButton';
import { UserRow } from '../relationships/UserList';
import { useUserSearch } from './api';

/** Find people by @username or name, and follow them (or request to, for private accounts). */
export function SearchPage() {
  // The query lives in the URL, so going back to search keeps it and results can be linked.
  const [params, setParams] = useSearchParams();
  const typed = params.get('q') ?? '';
  const search = useUserSearch(typed);
  const follow = useFollowUser();

  const setTyped = (value: string) =>
    setParams(value ? { q: value } : {}, { replace: true, preventScrollReset: true });

  const results = search.data ?? [];
  const hasQuery = search.debouncedQuery.length > 0;

  return (
    <>
      <PageHeader title="Search" />
      <div className="border-b border-border px-4 py-3">
        <label className="flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 focus-within:border-accent">
          <SearchIcon className="size-5 shrink-0 text-muted" />
          <span className="sr-only">Search people</span>
          <input
            type="search"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Search by name or @username"
            maxLength={USER_SEARCH_QUERY_MAX}
            autoFocus
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none"
          />
        </label>
      </div>

      {!typed.trim() ? (
        <EmptyState
          icon={<SearchIcon />}
          title="Find people"
          description="Search by name or @username. Private accounts get a follow request they can approve."
        />
      ) : search.isError ? (
        <ErrorState error={search.error} onRetry={() => void search.refetch()} />
      ) : !hasQuery || (search.isPending && results.length === 0) ? (
        <div className="space-y-3 p-4" aria-busy="true" aria-label="Searching">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : results.length === 0 ? (
        <EmptyState
          title={`No one matches “${search.debouncedQuery}”`}
          description="Check the spelling or try a shorter search."
        />
      ) : (
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
      )}
    </>
  );
}
