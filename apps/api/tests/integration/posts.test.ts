import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { CommentModel } from '../../src/modules/comments/comment.model.js';
import { LikeModel } from '../../src/modules/engagement/engagement.models.js';
import { PostModel } from '../../src/modules/posts/post.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createWorld } from '../helpers/world.js';

describe('posts', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  it('creates a post with extracted hashtags and bumps the author’s post count', async () => {
    const alice = await world.user('alice');
    const res = await as(alice).post('/posts', {
      text: 'Shipping #Vibe today #buildInPublic #vibe',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'original',
      author: { username: 'alice' },
      hashtags: ['vibe', 'buildinpublic'],
      counts: { likes: 0, comments: 0, reposts: 0 },
      viewer: { liked: false, bookmarked: false, reposted: false, isAuthor: true },
    });
    expect((await world.profile(alice, 'alice')).counts.posts).toBe(1);
  });

  it.each([
    [{ text: '' }, 'empty text'],
    [{ text: 'x'.repeat(501) }, 'text over 500 characters'],
    [{ text: 'hi', authorId: '65a1b2c3d4e5f60718293a4b' }, 'a client-supplied author'],
    [{ text: { $ne: '' } }, 'an operator payload'],
  ] as [object, string][])('rejects %s', async (body) => {
    const alice = await world.user('alice');
    const res = await as(alice).post('/posts', body);
    expect(res.status).toBe(400);
  });

  it('lets only the author edit and delete', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const postId = await world.post(alice, 'first draft');

    expect((await as(bob).patch(`/posts/${postId}`, { text: 'hijacked' })).status).toBe(404);
    expect((await as(bob).delete(`/posts/${postId}`)).status).toBe(404);

    const edited = await as(alice).patch(`/posts/${postId}`, { text: 'final #edit' });
    expect(edited.body.data).toMatchObject({ text: 'final #edit', hashtags: ['edit'] });
    expect(edited.body.data.editedAt).toEqual(expect.any(String));

    const deletions = await Promise.all([
      as(alice).delete(`/posts/${postId}`),
      as(alice).delete(`/posts/${postId}`),
    ]);
    expect(deletions.map((r) => r.status).sort()).toEqual([204, 404]);
    expect((await as(alice).get(`/posts/${postId}`)).status).toBe(404);
    expect((await world.profile(alice, 'alice')).counts.posts).toBe(0);
  });

  it('paginates a profile timeline newest first without gaps or duplicates', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    for (let i = 0; i < 7; i++) await world.post(alice, `post ${i}`);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : '';
      const res = await as(bob).get(`/users/${alice.id}/posts?limit=3${query}`);
      seen.push(...res.body.data.map((post: { text: string }) => post.text));
      cursor = res.body.meta.nextCursor as string | null;
      // A new post arriving mid-pagination must not shift later pages.
      if (seen.length === 3) await world.post(alice, 'arrived late');
    } while (cursor);

    expect(seen).toEqual(['post 6', 'post 5', 'post 4', 'post 3', 'post 2', 'post 1', 'post 0']);
  });

  it('reads and deletes posts stored before media existed (no media field)', async () => {
    const alice = await world.user('alice');
    const created = await as(alice).post('/posts', { text: 'from before media' });
    const id = (created.body.data as { id: string }).id;
    // Documents written before a field existed lack it, and .lean() reads don't apply schema defaults.
    await PostModel.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $unset: { media: '' } },
    );

    const list = await as(alice).get(`/users/${alice.id}/posts`);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id, media: [] })]);
    const feed = await as(alice).get('/feed');
    expect(feed.status).toBe(200);
    expect(feed.body.data).toEqual([expect.objectContaining({ id, media: [] })]);
    expect((await as(alice).get(`/posts/${id}`)).status).toBe(200);
    expect((await as(alice).delete(`/posts/${id}`)).status).toBe(204);
  });

  it('rejects a tampered cursor', async () => {
    const alice = await world.user('alice');
    const res = await as(alice).get(`/users/${alice.id}/posts?cursor=not-a-cursor`);
    expect(res.status).toBe(400);
  });
});

describe('likes, bookmarks and reposts', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  it('counts twenty concurrent likes from one user exactly once', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const postId = await world.post(alice, 'like me');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => as(bob).put(`/posts/${postId}/like`)),
    );

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await LikeModel.countDocuments({ postId })).toBe(1);
    const post = (await as(bob).get(`/posts/${postId}`)).body.data;
    expect(post.counts.likes).toBe(1);
    expect(post.viewer.liked).toBe(true);
  });

  it('keeps the counter exact under concurrent likes from many users and interleaved unlikes', async () => {
    const author = await world.user('author');
    const postId = await world.post(author, 'popular');
    const fans = await Promise.all(Array.from({ length: 12 }, (_, i) => world.user(`fan${i}`)));
    await Promise.all(fans.map((fan) => as(fan).put(`/posts/${postId}/like`)));
    await Promise.all(
      fans
        .slice(0, 5)
        .flatMap((fan) => [
          as(fan).delete(`/posts/${postId}/like`),
          as(fan).delete(`/posts/${postId}/like`),
        ]),
    );

    expect(await LikeModel.countDocuments({ postId })).toBe(7);
    expect((await PostModel.findById(postId).lean())?.counts.likes).toBe(7);
  });

  it('lists likers and hides blocked accounts', async () => {
    const [alice, bob, carol] = [
      await world.user('alice'),
      await world.user('bob'),
      await world.user('carol'),
    ];
    const postId = await world.post(alice, 'hi');
    await as(bob).put(`/posts/${postId}/like`);
    await as(carol).put(`/posts/${postId}/like`);
    await as(alice).put(`/users/${carol.id}/block`);

    const likers = (await as(alice).get(`/posts/${postId}/likes`)).body.data;
    expect(likers.map((u: { username: string }) => u.username)).toEqual(['bob']);
  });

  it('bookmarks privately and lists saved posts newest first, skipping deleted ones', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const [first, second, third] = [
      await world.post(alice, 'one'),
      await world.post(alice, 'two'),
      await world.post(alice, 'three'),
    ];
    for (const id of [first, second, third]) await as(bob).put(`/posts/${id}/bookmark`);
    await as(bob).put(`/posts/${first}/bookmark`);
    await as(alice).delete(`/posts/${second}`);

    const saved = (await as(bob).get('/users/me/bookmarks')).body.data;
    expect(saved.map((post: { text: string }) => post.text)).toEqual(['three', 'one']);
    expect(saved[0].viewer.bookmarked).toBe(true);
    expect((await as(alice).get('/users/me/bookmarks')).body.data).toEqual([]);
  });

  it('reposts once per user, resolves reposts of reposts to the original, and undoes cleanly', async () => {
    const [alice, bob, carol] = [
      await world.user('alice'),
      await world.user('bob'),
      await world.user('carol'),
    ];
    const original = await world.post(alice, 'share me');

    const reposts = await Promise.all([
      as(bob).put(`/posts/${original}/repost`),
      as(bob).put(`/posts/${original}/repost`),
    ]);
    expect(reposts.every((r) => r.status === 200)).toBe(true);
    const bobsRepost = await PostModel.findOne({ authorId: bob.id, kind: 'repost' }).lean();
    expect(bobsRepost).not.toBeNull();

    // Reposting Bob's repost reposts Alice's original.
    await as(carol).put(`/posts/${bobsRepost?._id.toHexString()}/repost`);
    expect((await PostModel.findById(original).lean())?.counts.reposts).toBe(2);

    const timeline = (await as(alice).get(`/users/${bob.id}/posts`)).body.data;
    expect(timeline[0]).toMatchObject({
      kind: 'repost',
      sharedPost: { id: original, text: 'share me' },
    });

    const undone = await as(bob).delete(`/posts/${original}/repost`);
    expect(undone.body.data).toEqual({ active: false, count: 1 });
    expect((await as(bob).put(`/posts/${original}/repost`)).status).toBe(200);
  });

  it('re-checks visibility at read time: saved posts vanish when the author goes private or blocks', async () => {
    const [alice, carol, bob] = [
      await world.user('alice'),
      await world.user('carol'),
      await world.user('bob'),
    ];
    const fromAlice = await world.post(alice, 'was public');
    const fromCarol = await world.post(carol, 'also public');
    await as(bob).put(`/posts/${fromAlice}/bookmark`);
    await as(bob).put(`/posts/${fromCarol}/bookmark`);
    const quote = (await as(bob).post('/posts', { text: 'quoting', quotedPostId: fromAlice })).body
      .data.id as string;

    await as(alice).patch('/users/me/settings', { isPrivate: true });
    await as(carol).put(`/users/${bob.id}/block`);

    expect((await as(bob).get('/users/me/bookmarks')).body.data).toEqual([]);
    expect((await as(bob).get(`/posts/${quote}`)).body.data).toMatchObject({
      sharedPost: null,
      sharedPostUnavailable: true,
    });
  });

  it('quotes a post and flags the quote when the original disappears', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const original = await world.post(alice, 'quotable');
    const quote = await as(bob).post('/posts', { text: 'so true', quotedPostId: original });
    expect(quote.body.data).toMatchObject({ kind: 'quote', sharedPost: { id: original } });

    await as(alice).delete(`/posts/${original}`);
    const after = (await as(bob).get(`/posts/${quote.body.data.id}`)).body.data;
    expect(after).toMatchObject({ sharedPost: null, sharedPostUnavailable: true });
  });

  it('refuses to reshare posts from private accounts, even for approved followers', async () => {
    const [alice, priv] = [
      await world.user('alice'),
      await world.user('priv', { isPrivate: true }),
    ];
    await as(alice).put(`/users/${priv.id}/follow`);
    const [request] = (await as(priv).get('/users/me/follow-requests')).body.data;
    await as(priv).post(`/users/me/follow-requests/${request.id}/accept`);
    const postId = await world.post(priv, 'followers only');

    // The post says so up front, so the app never offers an action that will be refused.
    expect((await as(alice).get(`/posts/${postId}`)).body.data.viewer.canReshare).toBe(false);
    expect((await as(priv).get(`/posts/${postId}`)).body.data.viewer.canReshare).toBe(false);
    const publicPost = await world.post(alice, 'for everyone');
    expect((await as(priv).get(`/posts/${publicPost}`)).body.data.viewer.canReshare).toBe(true);

    expect((await as(alice).put(`/posts/${postId}/repost`)).status).toBe(403);
    expect((await as(alice).post('/posts', { text: 'look', quotedPostId: postId })).status).toBe(
      403,
    );
    // But liking is fine for an approved follower.
    expect((await as(alice).put(`/posts/${postId}/like`)).status).toBe(200);
  });
});

describe('comments', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  it('threads replies two levels deep and keeps counts in sync', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const postId = await world.post(alice, 'discuss');
    const top = (await as(bob).post(`/posts/${postId}/comments`, { text: 'first!' })).body.data;
    const reply = (
      await as(alice).post(`/posts/${postId}/comments`, { text: 'thanks', parentId: top.id })
    ).body.data;
    // A reply to a reply attaches to the top-level comment.
    const nested = (
      await as(bob).post(`/posts/${postId}/comments`, { text: 'np', parentId: reply.id })
    ).body.data;
    expect(nested.parentId).toBe(top.id);

    const post = (await as(alice).get(`/posts/${postId}`)).body.data;
    expect(post.counts.comments).toBe(3);
    const topLevel = (await as(alice).get(`/posts/${postId}/comments`)).body.data;
    expect(topLevel).toHaveLength(1);
    expect(topLevel[0].counts.replies).toBe(2);
    const replies = (await as(alice).get(`/comments/${top.id}/replies`)).body.data;
    expect(replies.map((c: { text: string }) => c.text)).toEqual(['thanks', 'np']);
  });

  it('paginates top-level comments newest first', async () => {
    const alice = await world.user('alice');
    const postId = await world.post(alice, 'busy thread');
    for (let i = 0; i < 5; i++)
      await as(alice).post(`/posts/${postId}/comments`, { text: `c${i}` });

    const first = await as(alice).get(`/posts/${postId}/comments?limit=2`);
    const second = await as(alice).get(
      `/posts/${postId}/comments?limit=2&cursor=${first.body.meta.nextCursor}`,
    );
    expect([...first.body.data, ...second.body.data].map((c: { text: string }) => c.text)).toEqual([
      'c4',
      'c3',
      'c2',
      'c1',
    ]);
  });

  it('lets the comment author or the post author delete, and no one else', async () => {
    const [alice, bob, carol] = [
      await world.user('alice'),
      await world.user('bob'),
      await world.user('carol'),
    ];
    const postId = await world.post(alice, 'moderated');
    const bobs = (await as(bob).post(`/posts/${postId}/comments`, { text: 'from bob' })).body.data;
    await as(carol).post(`/posts/${postId}/comments`, { text: 'reply', parentId: bobs.id });

    expect((await as(carol).delete(`/comments/${bobs.id}`)).status).toBe(403);
    expect((await as(alice).delete(`/comments/${bobs.id}`)).status).toBe(204);
    // Deleting a top-level comment removes it and its reply from the count.
    expect((await as(alice).get(`/posts/${postId}`)).body.data.counts.comments).toBe(0);
    expect((await as(alice).get(`/posts/${postId}/comments`)).body.data).toEqual([]);
    expect(await CommentModel.countDocuments({ deletedAt: null, parentId: null })).toBe(0);
  });

  it('hides comments from blocked users and refuses comments on invisible posts', async () => {
    const [alice, bob, priv] = [
      await world.user('alice'),
      await world.user('bob'),
      await world.user('priv', { isPrivate: true }),
    ];
    const postId = await world.post(alice, 'open');
    await as(bob).post(`/posts/${postId}/comments`, { text: 'rude' });
    await as(alice).put(`/users/${bob.id}/block`);
    expect((await as(alice).get(`/posts/${postId}/comments`)).body.data).toEqual([]);

    const privatePost = await world.post(priv, 'hidden');
    expect((await as(alice).post(`/posts/${privatePost}/comments`, { text: 'hi' })).status).toBe(
      404,
    );
  });
});
