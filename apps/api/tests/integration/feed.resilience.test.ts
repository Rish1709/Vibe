import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, describe, expect, it } from 'vitest';
import { CacheKeys } from '../../src/cache/keys.js';
import { FeedConfig } from '../../src/config/feed.js';
import { createFeedService } from '../../src/modules/feed/feed.service.js';
import { pullEntries, type PullSource } from '../../src/modules/feed/pull.source.js';
import { createTimelineStore } from '../../src/modules/feed/timeline.store.js';
import { PostModel } from '../../src/modules/posts/post.model.js';
import { FollowModel } from '../../src/modules/relationships/follow.model.js';
import type { AuthUser } from '../../src/modules/users/user.service.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { silentLogger } from '../helpers/testApp.js';
import { createWorld, type TestUser } from '../helpers/world.js';

const asAuthUser = (user: TestUser): AuthUser => ({
  id: user.id,
  clerkId: user.clerkId,
  username: user.username,
  deleted: false,
});

/**
 * A pull source that pauses inside a timeline rebuild, right after its MongoDB query returned and
 * before the result is written to Redis: the window where concurrent writes can be lost.
 */
function gatedRebuildPull() {
  let release: () => void = () => {};
  let reached: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const atGate = new Promise<void>((resolve) => (reached = resolve));
  const pull: PullSource = async (authorIds, cursor, limit, options) => {
    const entries = await pullEntries(authorIds, cursor, limit, options);
    if (cursor === null && limit === FeedConfig.timelineMaxEntries) {
      reached();
      await gate;
    }
    return entries;
  };
  return { pull, atGate, release };
}

describe('feed rebuild races', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const timeline = createTimelineStore(redis);

  it('keeps a post published while the timeline was being rebuilt', async () => {
    const [viewer, author] = [await world.user('viewer'), await world.user('author')];
    await world.as(viewer).put(`/users/${author.id}/follow`);
    const { pull, atGate, release } = gatedRebuildPull();
    const feed = createFeedService({ redis, logger: silentLogger, timeline, pull });

    const inFlight = feed.getFeed(asAuthUser(viewer), { limit: 20 });
    await atGate;
    // Published after the rebuild's query ran: the query can't see it, so only fan-out can deliver it.
    const post = await PostModel.create({
      authorId: author.id,
      kind: 'original',
      text: 'mid-rebuild',
    });
    await timeline.addToExisting([viewer.id], {
      id: post._id.toHexString(),
      t: post.createdAt.getTime(),
    });
    release();
    await inFlight;

    expect(
      await redis.zscore(CacheKeys.timeline(viewer.id), post._id.toHexString()),
    ).not.toBeNull();
    const next = await feed.getFeed(asAuthUser(viewer), { limit: 20 });
    expect(next.source).toBe('timeline');
    expect(next.items.map((p) => p.text)).toEqual(['mid-rebuild']);
  });

  it('discards a rebuild that raced with an unfollow', async () => {
    const [viewer, author] = [await world.user('viewer'), await world.user('author')];
    await world.as(viewer).put(`/users/${author.id}/follow`);
    const postId = await world.post(author, 'should vanish');
    const { pull, atGate, release } = gatedRebuildPull();
    const feed = createFeedService({ redis, logger: silentLogger, timeline, pull });

    const inFlight = feed.getFeed(asAuthUser(viewer), { limit: 20 });
    await atGate;
    // The unfollow commits and invalidates while the rebuild still holds pre-unfollow data.
    await FollowModel.deleteOne({ followerId: viewer.id, followeeId: author.id });
    await timeline.invalidate([viewer.id]);
    release();
    await inFlight;

    expect(await redis.zscore(CacheKeys.timeline(viewer.id), postId)).toBeNull();
    const next = await feed.getFeed(asAuthUser(viewer), { limit: 20 });
    expect(next.items.map((p) => p.text)).toEqual([]);
  });

  it('serves concurrent first loads without duplicate rebuilds or errors', async () => {
    const [viewer, author] = [await world.user('viewer'), await world.user('author')];
    await world.as(viewer).put(`/users/${author.id}/follow`);
    await world.post(author, 'popular');
    let rebuilds = 0;
    const counting: PullSource = (authorIds, cursor, limit, options) => {
      if (cursor === null && limit === FeedConfig.timelineMaxEntries) rebuilds++;
      return pullEntries(authorIds, cursor, limit, options);
    };
    const feed = createFeedService({ redis, logger: silentLogger, timeline, pull: counting });

    const pages = await Promise.all(
      Array.from({ length: 8 }, () => feed.getFeed(asAuthUser(viewer), { limit: 5 })),
    );
    expect(pages.every((page) => page.items[0]?.text === 'popular')).toBe(true);
    // One request rebuilds; the others are served from MongoDB rather than stampeding.
    expect(rebuilds).toBe(1);
  });
});

describe('feed with Redis unavailable', () => {
  useTestDatabase();
  // Nothing listens on this port. Fail fast: no offline queue, no reconnection attempts.
  const deadRedis = new Redis('redis://127.0.0.1:6399', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  deadRedis.on('error', () => {});
  afterAll(() => deadRedis.disconnect());
  const world = createWorld(deadRedis);

  it('serves a correct, paginated feed from MongoDB', async () => {
    const [viewer, a, b] = [
      await world.user('viewer'),
      await world.user('author_a'),
      await world.user('author_b'),
    ];
    await world.as(viewer).put(`/users/${a.id}/follow`);
    await world.as(viewer).put(`/users/${b.id}/follow`);
    for (let i = 0; i < 6; i++) await world.post(i % 2 ? a : b, `post ${i}`);

    const first = await world.as(viewer).get('/feed?limit=4');
    expect(first.status).toBe(200);
    expect(first.headers['x-feed-source']).toBe('database');
    const second = await world.as(viewer).get(`/feed?limit=4&cursor=${first.body.meta.nextCursor}`);
    const texts = [...first.body.data, ...second.body.data].map(
      (post: { text: string }) => post.text,
    );
    expect(texts).toEqual(['post 5', 'post 4', 'post 3', 'post 2', 'post 1', 'post 0']);
    expect(second.body.meta.nextCursor).toBeNull();
    // Writes still work too (feed updates are best-effort and never fail the request).
    expect(await PostModel.countDocuments({ authorId: new Types.ObjectId(a.id) })).toBe(3);
  });
});
