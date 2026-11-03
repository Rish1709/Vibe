import { useAuth, useClerk } from '@clerk/react';
import { Navigate, Outlet } from 'react-router';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { useMe } from '@/features/account/api';
import { ApiError } from '@/lib/apiClient';

export function FullPageSpinner() {
  return (
    <div role="status" aria-label="Loading" className="flex min-h-dvh items-center justify-center">
      <span className="size-8 animate-spin rounded-full border-2 border-accent border-t-transparent" />
    </div>
  );
}

/** Client-side guard for UX only. Every API route enforces authentication on the server. */
export function RequireAuth() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <FullPageSpinner />;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <Outlet />;
}

/** Sends signed-in users without a username to onboarding before they reach the app. */
export function RequireOnboarded() {
  const me = useMe();
  const { signOut } = useClerk();

  if (me.isPending) return <FullPageSpinner />;
  if (me.isError) {
    if (me.error instanceof ApiError && me.error.code === 'ACCOUNT_DELETED') {
      return (
        <EmptyState
          title="This account has been deleted"
          action={<Button onClick={() => void signOut()}>Sign out</Button>}
        />
      );
    }
    return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;
  }
  if (!me.data.onboarded) return <Navigate to="/onboarding" replace />;
  return <Outlet />;
}
