import { ClerkProvider, useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { setAuthTokenGetter } from '@/lib/apiClient';

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

/** Connects Clerk's session to the API client and the query cache. */
function AuthBridge() {
  const { getToken, isSignedIn } = useAuth();
  const queryClient = useQueryClient();

  // Assigned during render (idempotent) so the getter exists before any child query fires.
  setAuthTokenGetter(() => getToken());

  // Data cached for one account must never be shown to the next one on a shared device.
  useEffect(() => {
    if (isSignedIn === false) queryClient.clear();
  }, [isSignedIn, queryClient]);

  return null;
}

/**
 * Root route element. ClerkProvider lives inside the router so Clerk's redirects use client-side
 * navigation instead of full page reloads.
 */
export function RootLayout() {
  const navigate = useNavigate();

  if (!PUBLISHABLE_KEY) {
    return (
      <div className="mx-auto max-w-lg p-8">
        <h1 className="text-xl font-bold">Clerk is not configured</h1>
        <p className="mt-2 text-muted">
          Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> in <code>apps/web/.env.local</code> and
          restart the dev server.
        </p>
      </div>
    );
  }

  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      routerPush={(to) => navigate(to)}
      routerReplace={(to) => navigate(to, { replace: true })}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/sign-in"
      appearance={{ variables: { colorPrimary: '#7c3aed', borderRadius: '0.75rem' } }}
    >
      <AuthBridge />
      <Outlet />
    </ClerkProvider>
  );
}
