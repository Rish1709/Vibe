import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clerkState } from '@/test/clerkMock';
import { makeMe, makePost, makeProfile, mockApi, renderAt } from '@/test/utils';

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
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/feed': () => ({ json: { data: [], meta: { nextCursor: null } } }),
    });
    renderAt('/');
    expect(await screen.findByRole('heading', { name: 'Home' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav.querySelector('a[href="/ada"]')).not.toBeNull();
    expect(await screen.findByText('Your feed is quiet')).toBeInTheDocument();
  });

  it('shows the home feed and loads the next page with its cursor', async () => {
    const grace = {
      id: 'e'.repeat(24),
      username: 'grace',
      displayName: 'Grace Hopper',
      avatarUrl: null,
    };
    const viewerFlags = { liked: false, bookmarked: false, reposted: false, isAuthor: false };
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/feed': () => {
        const isSecondPage =
          calls.filter((call) => call.path.startsWith('/api/v1/feed')).length > 1;
        return isSecondPage
          ? {
              json: {
                data: [makePost({ text: 'older post', author: grace, viewer: viewerFlags })],
                meta: { nextCursor: null },
              },
            }
          : {
              json: {
                data: [makePost({ text: 'newest post', author: grace, viewer: viewerFlags })],
                meta: { nextCursor: 'CURSOR1' },
              },
            };
      },
    });
    // jsdom has no layout, so the infinite-scroll sentinel never intersects; trigger it explicitly.
    const observed: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          observed.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    renderAt('/');
    expect(await screen.findByText('newest post')).toBeInTheDocument();

    for (const callback of observed) {
      callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
    expect(await screen.findByText('older post')).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/api/v1/feed?cursor=CURSOR1')).toBe(true);
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

  it('offers editing on the user’s own profile and lists their posts', async () => {
    const me = makeMe();
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: me } }),
      'GET /api/v1/users/ada': () => ({ json: { data: makeProfile({ viewer: null }) } }),
      [`GET /api/v1/users/${me.id}/posts`]: () => ({
        json: { data: [makePost({ text: 'my first post' })], meta: { nextCursor: null } },
      }),
    });
    renderAt('/ada');
    expect(await screen.findByRole('link', { name: 'Edit profile' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(await screen.findByText('my first post')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Follow' })).not.toBeInTheDocument();
  });

  it('hides a private account’s posts from non-followers without requesting them', async () => {
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/users/grace': () => ({
        json: {
          data: makeProfile({
            id: 'b'.repeat(24),
            username: 'grace',
            isPrivate: true,
            canViewContent: false,
          }),
        },
      }),
    });
    renderAt('/grace');
    expect(await screen.findByText('This account is private')).toBeInTheDocument();
    expect(calls.some((call) => call.path.includes('/posts'))).toBe(false);
  });
});
