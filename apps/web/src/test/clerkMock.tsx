import type { ReactNode } from 'react';

/**
 * Controls the auth state Clerk's hooks report in component tests. Clerk is a third-party UI/session
 * SDK; these tests cover our routing and forms, not Clerk itself. Use in a test file with:
 *   vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);
 */
export const clerkState = {
  isLoaded: true,
  isSignedIn: true,
  signOut: (): Promise<void> => Promise.resolve(),
};

export const clerkModule = {
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    getToken: () => Promise.resolve('test-token'),
  }),
  useClerk: () => ({ signOut: clerkState.signOut }),
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  SignIn: () => <div>Clerk sign-in form</div>,
  SignUp: () => <div>Clerk sign-up form</div>,
};
