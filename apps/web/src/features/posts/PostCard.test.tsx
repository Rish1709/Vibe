import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMe, makePost, makeProfile, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

const me = makeMe();
const otherAuthor = {
  id: 'c'.repeat(24),
  username: 'grace',
  displayName: 'Grace Hopper',
  avatarUrl: null,
};

function setup(
  post = makePost({
    author: otherAuthor,
    viewer: { liked: false, bookmarked: false, reposted: false, isAuthor: false },
    counts: { likes: 4, comments: 2, reposts: 1 },
  }),
  likeStatus = 200,
) {
  const calls = mockApi({
    'GET /api/v1/users/me': () => ({ json: { data: me } }),
    'GET /api/v1/users/grace': () => ({
      json: { data: makeProfile({ id: otherAuthor.id, username: 'grace' }) },
    }),
    [`GET /api/v1/users/${otherAuthor.id}/posts`]: () => ({
      json: { data: [post], meta: { nextCursor: null } },
    }),
    [`PUT /api/v1/posts/${post.id}/like`]: () =>
      likeStatus === 200
        ? { json: { data: { active: true, count: 10 } } }
        : { status: likeStatus, json: { error: { code: 'INTERNAL_ERROR', message: 'boom' } } },
  });
  renderAt('/grace');
  return { calls, post };
}

describe('PostCard', () => {
  it('likes optimistically, then adopts the server’s count', async () => {
    setup();
    const user = userEvent.setup();
    const article = (await screen.findByText('hello world')).closest('article') as HTMLElement;
    const like = within(article).getByRole('button', { name: 'Like' });
    expect(like).toHaveTextContent('4');

    await user.click(like);
    // Optimistic: flipped and incremented before the server answers.
    const unlike = within(article).getByRole('button', { name: 'Unlike' });
    expect(unlike).toHaveAttribute('aria-pressed', 'true');
    // Authoritative: the server said 10 (others liked it meanwhile).
    await waitFor(() => expect(unlike).toHaveTextContent('10'));
  });

  it('rolls the like back when the server fails', async () => {
    setup(undefined, 500);
    const user = userEvent.setup();
    const article = (await screen.findByText('hello world')).closest('article') as HTMLElement;
    await user.click(within(article).getByRole('button', { name: 'Like' }));

    const like = await within(article).findByRole('button', { name: 'Like' });
    expect(like).toHaveAttribute('aria-pressed', 'false');
    expect(like).toHaveTextContent('4');
    expect(await screen.findByText("Couldn't update. Please try again.")).toBeInTheDocument();
  });

  it('shows reposts as the original post with a banner and an unavailable state', async () => {
    const original = makePost({
      author: otherAuthor,
      text: 'the original',
      viewer: { liked: false, bookmarked: false, reposted: false, isAuthor: false },
    });
    const repost = makePost({
      kind: 'repost',
      text: '',
      author: otherAuthor,
      sharedPost: original,
      viewer: { liked: false, bookmarked: false, reposted: false, isAuthor: false },
    });
    const gone = makePost({
      kind: 'repost',
      text: '',
      author: otherAuthor,
      sharedPost: null,
      sharedPostUnavailable: true,
      viewer: { liked: false, bookmarked: false, reposted: false, isAuthor: false },
    });
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: me } }),
      'GET /api/v1/users/grace': () => ({
        json: { data: makeProfile({ id: otherAuthor.id, username: 'grace' }) },
      }),
      [`GET /api/v1/users/${otherAuthor.id}/posts`]: () => ({
        json: { data: [repost, gone], meta: { nextCursor: null } },
      }),
    });
    renderAt('/grace');

    expect(await screen.findByText('the original')).toBeInTheDocument();
    expect(screen.getAllByText('Grace Hopper reposted')).toHaveLength(2);
    expect(screen.getByText('This post is unavailable.')).toBeInTheDocument();
  });

  it('only offers edit and delete to the author', async () => {
    const mine = makePost({
      text: 'mine',
      author: { id: me.id, username: 'ada', displayName: 'Ada Lovelace', avatarUrl: null },
    });
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: me } }),
      'GET /api/v1/users/ada': () => ({ json: { data: makeProfile({ viewer: null }) } }),
      [`GET /api/v1/users/${me.id}/posts`]: () => ({
        json: { data: [mine], meta: { nextCursor: null } },
      }),
    });
    renderAt('/ada');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Post options' }));
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });
});
