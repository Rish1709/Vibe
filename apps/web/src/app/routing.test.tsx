import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkState } from '@/test/clerkMock';
import { makeMe, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

beforeEach(() => {
  clerkState.isSignedIn = true;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('route guards', () => {
  it('sends signed-out visitors to sign-in', async () => {
    clerkState.isSignedIn = false;
    const { router } = renderAt('/settings');
    expect(await screen.findByText('Clerk sign-in form')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('sends signed-in users without a username to onboarding', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({
        json: { data: makeMe({ username: null, onboarded: false }) },
      }),
    });
    const { router } = renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Pick your username' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/onboarding');
  });

  it('keeps onboarded users out of onboarding', async () => {
    mockApi({ 'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }) });
    const { router } = renderAt('/onboarding');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('renders the app shell with navigation to the user’s own profile', async () => {
    mockApi({ 'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }) });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav.querySelector('a[href="/ada"]')).not.toBeNull();
  });

  it('shows a dedicated screen for deleted accounts', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({
        status: 403,
        json: { error: { code: 'ACCOUNT_DELETED', message: 'This account has been deleted' } },
      }),
    });
    renderAt('/');
    expect(await screen.findByText('This account has been deleted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});

describe('profile page', () => {
  it('shows a not-found state for unknown usernames', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/users/ghost': () => ({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'User not found' } },
      }),
    });
    renderAt('/ghost');
    expect(await screen.findByText("This account doesn't exist")).toBeInTheDocument();
  });

  it('offers editing only on the user’s own profile', async () => {
    const me = makeMe();
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: me } }),
      'GET /api/v1/users/ada': () => ({ json: { data: { ...me, username: 'ada' } } }),
    });
    renderAt('/ada');
    expect(await screen.findByRole('link', { name: 'Edit profile' })).toHaveAttribute(
      'href',
      '/settings',
    );
  });
});
