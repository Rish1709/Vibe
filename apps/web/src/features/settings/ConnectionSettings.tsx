import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  useBlock,
  useBlockedUsers,
  useFollowRequests,
  useRespondToRequest,
} from '../relationships/api';
import { UserRow } from '../relationships/UserList';

export function FollowRequests() {
  const requests = useFollowRequests();
  const respond = useRespondToRequest();

  if (requests.isPending) return <Skeleton className="h-12" />;
  if (requests.isError)
    return <p className="text-sm text-danger">Couldn't load follow requests.</p>;
  const items = requests.data.pages.flatMap((page) => page.items);
  if (items.length === 0) return <p className="text-sm text-muted">No pending requests.</p>;

  return (
    <ul className="-mx-4 divide-y divide-border">
      {items.map((request) => {
        const busy = respond.isPending && respond.variables.requestId === request.id;
        return (
          <UserRow
            key={request.id}
            user={request.user}
            action={
              <div className="flex gap-2">
                <Button
                  className="px-4 py-1.5"
                  disabled={busy}
                  onClick={() => respond.mutate({ requestId: request.id, accept: true })}
                >
                  Confirm
                </Button>
                <Button
                  variant="secondary"
                  className="px-4 py-1.5"
                  disabled={busy}
                  onClick={() => respond.mutate({ requestId: request.id, accept: false })}
                >
                  Delete
                </Button>
              </div>
            }
          />
        );
      })}
    </ul>
  );
}

function BlockedRow({
  user,
}: {
  user: { id: string; username: string; displayName: string; avatarUrl: string | null };
}) {
  const unblock = useBlock(user);
  return (
    <UserRow
      user={user}
      action={
        <Button
          variant="secondary"
          className="px-4 py-1.5"
          loading={unblock.isPending}
          onClick={() => unblock.mutate(false)}
        >
          Unblock
        </Button>
      }
    />
  );
}

export function BlockedAccounts() {
  const blocked = useBlockedUsers();
  if (blocked.isPending) return <Skeleton className="h-12" />;
  if (blocked.isError)
    return <p className="text-sm text-danger">Couldn't load blocked accounts.</p>;
  const users = blocked.data.pages.flatMap((page) => page.items);
  if (users.length === 0) return <p className="text-sm text-muted">You haven't blocked anyone.</p>;
  return (
    <ul className="-mx-4 divide-y divide-border">
      {users.map((user) => (
        <BlockedRow key={user.id} user={user} />
      ))}
    </ul>
  );
}
