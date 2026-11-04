import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { CacheKeys } from '../../src/cache/keys.js';
import { FeedConfig } from '../../src/config/feed.js';
import { PostModel } from '../../src/modules/posts/post.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { useFeedWorker } from '../helpers/feedWorker.js';
import { createWorld, type TestUser } from '../helpers/world.js';

describe('home feed', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const fanout = useFeedWorker(redis);
  const world = createWorld(redis, { feedQueue: fanout.queue });
  const { as } = world;

  async function feed(viewer: TestUser, query = '') {
    const res = await as(viewer).get(`/feed${query}`);
    expect(res.status).toBe(200);
    return {
      texts: res.body.data.map(
        (post: { text: string; kind: string; sharedPost?: { text: string } }) =>
          post.kind === 'repost' ? `RT ${post.sharedPost?.text}` : post.text,
      ) as string[],
      nextCursor: res.body.meta.nextCursor as string | null,
      source: res.headers['x-feed-source'] as string,
    };
  }

  const follow = async (follower: TestUser, followee: TestUser) => {
    expect((await as(follower).put(`/users/${followee.id}/follow`)).status).toBe(200);
  };

  it('is empty for a new user and shows their own post immediately (read-your-writes)', async () => {
    const alice = await world.user('alice');
    expect((await feed(alice)).texts).toEqual([]);

    await world.post(alice, 'hello me');
    // No drain: the author's own timeline is updated synchronously.
    expect((await feed(alice)).texts).toEqual(['hello me']);
  });

  it('includes a followee’s existing posts right after following (timeline rebuilt)', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await world.post(bob, 'older');
    await world.post(bob, 'newer');
    await feed(alice); // materialize alice's timeline before the follow

    await follow(alice, bob);
    const page = await feed(alice);
    expect(page.texts).toEqual(['newer', 'older']);
    expect(page.source).toBe('timeline');
  });

  it('delivers new posts from followees via fan-out, newest first, from the timeline', async () => {
    const [alice, bob, carol] = [
      await world.user('alice'),
      await world.user('bob'),
      await world.user('carol'),
    ];
    await follow(alice, bob);
    await follow(alice, carol);
    await feed(alice);

    await world.post(bob, 'from bob');
    await world.post(carol, 'from carol');
    await world.post(alice, 'from alice');
    await fanout.drain();

    const page = await feed(alice);
    expect(page.texts).toEqual(['from alice', 'from carol', 'from bob']);
    expect(page.source).toBe('timeline');
    // The fanned-out post really is in Redis, not computed on the fly.
    const bobsPost = await PostModel.findOne({ text: 'from bob' }).lean();
    expect(
      await redis.zscore(CacheKeys.timeline(alice.id), bobsPost?._id.toHexString() ?? ''),
    ).not.toBeNull();
  });

  it('really runs fan-out in the background: one completed job per post, none failed', async () => {
    // Feed errors are logged rather than thrown (they must never fail the user's request), which
    // once hid a total fan-out outage behind correct-looking feeds. This test fails loudly instead.
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await follow(alice, bob);
    await feed(alice);
    const before = await fanout.completedCount();
    await world.post(bob, 'one');
    await world.post(bob, 'two');
    await fanout.drain();

    expect((await fanout.completedCount()) - before).toBe(2);
    expect(await fanout.failedCount()).toBe(0);
    // Delivered by the job, not by a rebuild: the timeline existed before both posts.
    expect(await redis.zcard(CacheKeys.timeline(alice.id))).toBe(3);
  });

  it('deduplicates a fan-out enqueued twice for the same post', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await follow(alice, bob);
    await feed(alice);
    const postId = await world.post(bob, 'once');
    await fanout.drain();
    const before = await fanout.completedCount();
    const post = await PostModel.findById(postId).lean();
    await fanout.queue.enqueue({
      action: 'publish',
      postId,
      authorId: bob.id,
      t: post?.createdAt.getTime() ?? 0,
    });
    await fanout.drain();
    expect((await fanout.completedCount()) - before).toBe(0);
  });

  it('shows reposts from followees as reposts', async () => {
    const [alice, bob, carol] = [
      await world.user('alice'),
      await world.user('bob'),
      await world.user('carol'),
    ];
    const original = await world.post(carol, 'worth sharing');
    await follow(alice, bob);
    await feed(alice);
    await as(bob).put(`/posts/${original}/repost`);
    await fanout.drain();
    expect((await feed(alice)).texts).toEqual(['RT worth sharing']);
  });

  it('paginates without gaps or duplicates while new posts keep arriving', async () => {
    const viewer = await world.user('viewer');
    const authors = [
      await world.user('author1'),
      await world.user('author2'),
      await world.user('author3'),
    ];
    for (const author of authors) await follow(viewer, author);
    for (let i = 0; i < 25; i++)
      await world.post(authors[i % 3] as TestUser, `p${String(i).padStart(2, '0')}`);
    await fanout.drain();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await feed(viewer, `?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.texts);
      cursor = page.nextCursor;
      pages++;
      if (pages === 1) {
        await world.post(authors[0] as TestUser, 'arrived mid-scroll');
        await fanout.drain();
      }
    } while (cursor);

    const expected = Array.from({ length: 25 }, (_, i) => `p${String(24 - i).padStart(2, '0')}`);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);
    // The newcomer shows up when the user refreshes from the top.
    expect((await feed(viewer, '?limit=1')).texts).toEqual(['arrived mid-scroll']);
  });

  it('drops an unfollowed author and both sides of a block', async () => {
    const [alice, bob, carol] = [
      await world.user('alice'),
      await world.user('bob'),
      await world.user('carol'),
    ];
    await follow(alice, bob);
    await follow(alice, carol);
    await follow(bob, alice);
    await world.post(bob, 'bob says');
    await world.post(carol, 'carol says');
    await world.post(alice, 'alice says');
    await fanout.drain();
    expect((await feed(alice)).texts).toEqual(['alice says', 'carol says', 'bob says']);

    await as(alice).delete(`/users/${carol.id}/follow`);
    expect((await feed(alice)).texts).toEqual(['alice says', 'bob says']);

    await as(bob).put(`/users/${alice.id}/block`);
    expect((await feed(alice)).texts).toEqual(['alice says']);
    expect((await feed(bob)).texts).toEqual(['bob says']);
  });

  it('removes a deleted post at once and cleans it out of timelines after fan-out', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await follow(alice, bob);
    await feed(alice);
    const postId = await world.post(bob, 'regret');
    await fanout.drain();
    expect((await feed(alice)).texts).toEqual(['regret']);

    await as(bob).delete(`/posts/${postId}`);
    // Hydration hides it before any cleanup runs.
    expect((await feed(alice)).texts).toEqual([]);
    await fanout.drain();
    expect(await redis.zscore(CacheKeys.timeline(alice.id), postId)).toBeNull();
  });

  it('only shows a private account’s posts once the follow request is accepted', async () => {
    const [alice, priv] = [
      await world.user('alice'),
      await world.user('priv', { isPrivate: true }),
    ];
    await world.post(priv, 'members only');
    await as(alice).put(`/users/${priv.id}/follow`);
    expect((await feed(alice)).texts).toEqual([]);

    const [request] = (await as(priv).get('/users/me/follow-requests')).body.data;
    await as(priv).post(`/users/me/follow-requests/${request.id}/accept`);
    expect((await feed(alice)).texts).toEqual(['members only']);
  });

  describe('celebrity authors (pulled at read time, not fanned out)', () => {
    it('merges their posts into followers’ feeds without writing to follower timelines', async () => {
      // The test threshold is 3 followers.
      const star = await world.user('star');
      const friend = await world.user('friend');
      const fans = [await world.user('fan1'), await world.user('fan2'), await world.user('fan3')];
      for (const fan of fans) {
        await follow(fan, star);
        await follow(fan, friend);
        await feed(fan);
      }

      const starPost = await world.post(star, 'star post');
      await world.post(friend, 'friend post');
      await fanout.drain();

      for (const fan of fans) {
        expect((await feed(fan)).texts).toEqual(['friend post', 'star post']);
        expect(await redis.zscore(CacheKeys.timeline(fan.id), starPost)).toBeNull();
      }
    });
  });

  it('continues from MongoDB past the end of a full (trimmed) timeline', async () => {
    const [viewer, prolific] = [await world.user('viewer'), await world.user('prolific')];
    await follow(viewer, prolific);
    const total = FeedConfig.timelineMaxEntries + 30;
    const base = Date.now() - total * 1000;
    await PostModel.insertMany(
      Array.from({ length: total }, (_, i) => ({
        _id: new Types.ObjectId(),
        authorId: new Types.ObjectId(prolific.id),
        kind: 'original',
        text: `n${i}`,
        createdAt: new Date(base + i * 1000),
        updatedAt: new Date(base + i * 1000),
      })),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await feed(viewer, `?limit=50${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.texts);
      cursor = page.nextCursor;
    } while (cursor);

    // The cap, plus the anchor member that keeps the key alive.
    expect(await redis.zcard(CacheKeys.timeline(viewer.id))).toBe(
      FeedConfig.timelineMaxEntries + 1,
    );
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe(`n${total - 1}`);
    expect(seen.at(-1)).toBe('n0');
  }, 60_000);
});
