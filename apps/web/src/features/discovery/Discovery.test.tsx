import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SuggestedUserDto, TrendingHashtagDto } from '@vibe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMe, makePost, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

const trending: TrendingHashtagDto[] = [
  { tag: 'worldcup', posts: 12, authors: 9 },
  { tag: 'vibe', posts: 1, authors: 1 },
];
const suggested: SuggestedUserDto[] = [
  {
    id: 'd'.repeat(24),
    username: 'grace',
    displayName: 'Grace Hopper',
    avatarUrl: null,
    isPrivate: false,
    viewer: { following: 'none' },
    mutuals: 2,
  },
];

describe('explore', () => {
  it('shows trending hashtags and who to follow, and follows from the list', async () => {
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/explore/trending': () => ({ json: { data: trending } }),
      'GET /api/v1/explore/suggestions': () => ({ json: { data: suggested } }),
      [`PUT /api/v1/users/${'d'.repeat(24)}/follow`]: () => ({
        json: { data: { following: 'active' } },
      }),
    });
    renderAt('/explore');
    const user = userEvent.setup();

    const tags = await screen.findByRole('list', { name: 'Trending hashtags' });
    expect(within(tags).getByRole('link', { name: /#worldcup/ })).toHaveAttribute(
      'href',
      '/hashtag/worldcup',
    );
    expect(within(tags).getByText('9 people · 12 posts')).toBeInTheDocument();
    expect(within(tags).getByText('1 person · 1 post')).toBeInTheDocument();

    const people = await screen.findByRole('list', { name: 'Who to follow' });
    expect(within(people).getByText('Followed by 2 people you follow')).toBeInTheDocument();
    await user.click(within(people).getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
  });

  it('sends a search to the results page', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/explore/trending': () => ({ json: { data: [] } }),
      'GET /api/v1/explore/suggestions': () => ({ json: { data: [] } }),
      'GET /api/v1/search/users': () => ({ json: { data: [] } }),
    });
    const { router } = renderAt('/explore');
    const user = userEvent.setup();
    expect(await screen.findByText(/Nothing is trending yet/)).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: 'Search Vibe' }), 'grace{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toBe('?q=grace');
  });
});

describe('post search and hashtags', () => {
  it('searches posts on the Posts tab', async () => {
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/search/posts': () => ({
        json: { data: [makePost({ text: 'coffee in the park' })], meta: { nextCursor: null } },
      }),
    });
    renderAt('/search?q=coffee&type=posts');
    expect(await screen.findByText('coffee in the park')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'posts' })).toHaveAttribute('aria-selected', 'true');
    expect(calls.find((c) => c.path.startsWith('/api/v1/search/posts'))?.path).toBe(
      '/api/v1/search/posts?q=coffee',
    );
  });

  it('turns hashtags in posts into links to the hashtag page', async () => {
    const post = makePost({ text: 'kickoff soon #WorldCup' });
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/hashtags/worldcup/posts': () => ({
        json: { data: [post], meta: { nextCursor: null } },
      }),
      'GET /api/v1/search/posts': () => ({ json: { data: [post], meta: { nextCursor: null } } }),
    });
    const { router } = renderAt('/search?q=kickoff&type=posts');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('link', { name: '#WorldCup' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/hashtag/worldcup'));
    expect(await screen.findByRole('heading', { name: '#worldcup' })).toBeInTheDocument();
    expect(await screen.findByText(/kickoff soon/)).toBeInTheDocument();
  });
});
