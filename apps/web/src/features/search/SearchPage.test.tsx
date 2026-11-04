import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FollowState, UserSearchResultDto } from '@vibe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMe, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

const privy = (following: FollowState): UserSearchResultDto => ({
  id: 'e'.repeat(24),
  username: 'privy',
  displayName: 'Private Person',
  avatarUrl: null,
  isPrivate: true,
  viewer: { following },
});

/** Stateful like the real API: after the follow request, search reports it as pending. */
function searchRoutes() {
  let state: FollowState = 'none';
  return mockApi({
    'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
    'GET /api/v1/search/users': () => ({ json: { data: [privy(state)] } }),
    [`PUT /api/v1/users/${'e'.repeat(24)}/follow`]: () => {
      state = 'pending';
      return { json: { data: { following: state } } };
    },
  });
}

describe('search page', () => {
  it('finds a private account and sends a follow request', async () => {
    const calls = searchRoutes();
    renderAt('/search');
    const user = userEvent.setup();

    await user.type(await screen.findByRole('searchbox', { name: 'Search people' }), 'priv');
    const people = await screen.findByRole('list', { name: 'People' });
    expect(within(people).getByText('Private Person')).toBeInTheDocument();
    expect(within(people).getByLabelText('Private account')).toBeInTheDocument();

    // Debounced: one search for the settled text, not one per keystroke.
    const searches = calls.filter((c) => c.path.startsWith('/api/v1/search/users'));
    expect(searches.map((c) => c.path)).toEqual(['/api/v1/search/users?q=priv']);

    await user.click(within(people).getByRole('button', { name: 'Follow' }));
    expect(
      await within(people).findByRole('button', { name: 'Cancel follow request' }),
    ).toHaveTextContent('Requested');
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  });

  it('keeps the query in the URL and says when nothing matches', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/search/users': () => ({ json: { data: [] } }),
    });
    renderAt('/search?q=nobody');

    expect(await screen.findByRole('searchbox', { name: 'Search people' })).toHaveValue('nobody');
    expect(await screen.findByText('No one matches “nobody”')).toBeInTheDocument();
  });
});
