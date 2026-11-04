import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMe, makeProfile, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

const target = makeProfile({
  id: 'd'.repeat(24),
  username: 'grace',
  counts: { followers: 7, following: 1, posts: 0 },
});

/** A stateful fake: after the follow, the profile endpoint reflects it, like the real API. */
function profileRoutes(initial = target, followResult: 'active' | 'pending' = 'active') {
  let profile = initial;
  return mockApi({
    'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
    'GET /api/v1/users/grace': () => ({ json: { data: profile } }),
    [`GET /api/v1/users/${initial.id}/posts`]: () => ({
      json: { data: [], meta: { nextCursor: null } },
    }),
    [`PUT /api/v1/users/${initial.id}/follow`]: () => {
      profile = {
        ...profile,
        viewer: { following: followResult, followedBy: false, blocking: false },
        counts: {
          ...profile.counts,
          followers: profile.counts.followers + (followResult === 'active' ? 1 : 0),
        },
      };
      return { json: { data: { following: followResult } } };
    },
  });
}

describe('following from a profile', () => {
  it('follows a public account and updates the follower count immediately', async () => {
    const calls = profileRoutes();
    renderAt('/grace');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Follow' }));
    expect(screen.getByRole('button', { name: 'Unfollow' })).toHaveTextContent('Following');
    expect(screen.getByRole('link', { name: /8 followers/ })).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  });

  it('sends a request to a private account without changing the count', async () => {
    profileRoutes(makeProfile({ ...target, isPrivate: true, canViewContent: false }), 'pending');
    renderAt('/grace');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Follow' }));
    expect(screen.getByRole('button', { name: 'Cancel follow request' })).toHaveTextContent(
      'Requested',
    );
    expect(screen.getByText('7')).toBeInTheDocument();
  });
});
