import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { createNotificationProcessor } from '../../src/modules/notifications/notification.processor.js';
import { createRecordingNotificationQueue } from '../../src/modules/notifications/notification.queue.js';
import { createRecordingPublisher } from '../../src/realtime/publisher.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createTestMediaProvider, uploadMedia } from '../helpers/media.js';
import { silentLogger } from '../helpers/testApp.js';
import { createWorld } from '../helpers/world.js';

interface ProfiledOp {
  op: string;
  ns: string;
  command?: Record<string, unknown>;
  planSummary?: string;
  hasSortStage?: boolean;
  docsExamined?: number;
  nreturned?: number;
}

/**
 * Phase 9 performance check, measured rather than assumed: MongoDB's profiler records every query
 * the real API runs during a tour of the app, and the test fails if any of them reads a whole
 * collection (COLLSCAN) or sorts in memory instead of reading an index in order.
 *
 * Both are invisible at test sizes and grow with the data: a COLLSCAN reads every document, and an
 * in-memory sort must hold every match (MongoDB aborts past 100 MB). Exceptions are listed with the
 * reason each one is acceptable.
 */
const ALLOWED: { why: string; matches: (op: ProfiledOp) => boolean }[] = [
  {
    why: '$text search returns matches unordered, so newest-first needs a sort (documented trade-off)',
    matches: (op) => op.planSummary?.includes('TEXT') ?? false,
  },
  {
    why: 'trending aggregates a week of posts by design, from the _id range; cached for 5 minutes',
    matches: (op) =>
      op.ns.endsWith('.posts') &&
      Array.isArray(op.command?.pipeline) &&
      JSON.stringify(op.command.pipeline).includes('$unwind'),
  },
  {
    why:
      'who-to-follow ranks counts it just computed ($group then $sort): no index can hold them. ' +
      'The input is bounded (200 seed followees, read by index) and the result is cached 10 minutes',
    matches: (op) =>
      op.ns.endsWith('.follows') &&
      Array.isArray(op.command?.pipeline) &&
      JSON.stringify(op.command.pipeline).includes('"$group"'),
  },
];

const describeOp = (op: ProfiledOp) =>
  `${op.ns.split('.').pop()} ${op.op} ${op.planSummary ?? ''} sort=${op.hasSortStage ?? false} ` +
  JSON.stringify(op.command?.filter ?? op.command?.q ?? op.command?.pipeline ?? {}).slice(0, 160);

describe('query plans', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const media = createTestMediaProvider();
  const queue = createRecordingNotificationQueue();
  const world = createWorld(redis, { mediaProvider: media.provider, notificationQueue: queue });
  const { as } = world;
  const processor = createNotificationProcessor({
    realtime: createRecordingPublisher().publisher,
    logger: silentLogger,
  });

  it('serves every query of a tour of the app from an index, in index order', async () => {
    // Setup happens before profiling starts: onboarding is not what's being measured.
    const alice = await world.user('alice');
    const bob = await world.user('bob');
    const carol = await world.user('carol', { isPrivate: true });
    const avatar = await uploadMedia(as(alice), media, { purpose: 'avatar' });
    const storyMedia = await uploadMedia(as(bob), media, { purpose: 'story' });
    const postMedia = await uploadMedia(as(bob), media);

    const db = mongoose.connection.db!;
    await db.command({ profile: 2 });
    try {
      // Social graph
      await as(alice).put(`/users/${bob.id}/follow`);
      await as(bob).put(`/users/${alice.id}/follow`);
      await as(alice).put(`/users/${carol.id}/follow`);
      const requests = (await as(carol).get('/users/me/follow-requests')).body.data as {
        id: string;
      }[];
      await as(carol).post(`/users/me/follow-requests/${requests[0]!.id}/accept`);
      await as(alice).get(`/users/${bob.id}/followers`);
      await as(alice).get(`/users/${bob.id}/following`);
      await as(alice).get('/users/bob');
      await as(alice).patch('/users/me', { displayName: 'Alice A', avatarMediaId: avatar });

      // Posts and engagement
      const post = (await as(bob).post('/posts', { text: 'hello #world', mediaIds: [postMedia] }))
        .body.data.id as string;
      await as(alice).put(`/posts/${post}/like`);
      await as(alice).put(`/posts/${post}/bookmark`);
      await as(alice).put(`/posts/${post}/repost`);
      await as(alice).post('/posts', { text: 'quoting', quotedPostId: post });
      const comment = (await as(alice).post(`/posts/${post}/comments`, { text: 'nice' })).body.data
        .id as string;
      await as(bob).post(`/posts/${post}/comments`, { text: 'thanks', parentId: comment });
      await as(alice).get(`/posts/${post}`);
      await as(alice).get(`/posts/${post}/likes`);
      await as(alice).get(`/posts/${post}/comments`);
      await as(alice).get(`/comments/${comment}/replies`);
      await as(alice).get(`/users/${bob.id}/posts`);
      await as(alice).get('/users/me/bookmarks');
      await as(alice).patch(`/posts/${post}`, { text: 'x' }); // not hers: a 404, still a query
      await as(alice).delete(`/posts/${post}/like`);

      // Feed, stories, discovery
      await as(alice).get('/feed');
      const story = (await as(bob).post('/stories', { mediaId: storyMedia })).body.data
        .id as string;
      await as(alice).get('/stories/tray');
      await as(alice).post(`/stories/${story}/views`);
      await as(bob).get(`/stories/${story}/viewers`);
      await as(alice).get(`/users/${bob.id}/stories`);
      await as(alice).get('/hashtags/world/posts');
      await as(alice).get('/search/users?q=bo');
      await as(alice).get('/explore/suggestions');

      // Messages and notifications
      const conversation = (await as(alice).post('/conversations', { userId: bob.id })).body.data
        .id as string;
      await as(alice).post(`/conversations/${conversation}/messages`, {
        text: 'hi',
        clientId: randomUUID(),
      });
      await as(bob).get('/conversations');
      await as(bob).get(`/conversations/${conversation}/messages`);
      await as(bob).post(`/conversations/${conversation}/read`);
      await new Promise((resolve) => setImmediate(resolve));
      for (const event of queue.events.splice(0)) await processor.process(event);
      await as(bob).get('/notifications');
      await as(bob).get('/notifications/unread-counts');
      await as(bob).post('/notifications/read');

      // Removal paths
      await as(alice).delete(`/users/${carol.id}/follow`);
      await as(bob).delete(`/posts/${post}`);
    } finally {
      await db.command({ profile: 0 });
    }

    const ops = (await db
      .collection('system.profile')
      .find({ ns: { $not: /system\./ }, op: { $in: ['query', 'update', 'remove', 'command'] } })
      .toArray()) as unknown as ProfiledOp[];
    const queries = ops.filter((op) => op.planSummary !== undefined);
    // The tour really exercised the database (guards against profiling silently doing nothing).
    expect(queries.length).toBeGreaterThan(100);

    const offenders = queries
      .filter((op) => op.planSummary!.includes('COLLSCAN') || op.hasSortStage === true)
      .filter((op) => !ALLOWED.some((allowed) => allowed.matches(op)))
      .map(describeOp);
    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * Query budgets. Round trips multiply network latency (about 4 ms each to MongoDB in Docker on
   * Windows, measured by the load test), so the count per request matters as much as each plan.
   * A page must cost the same whether it holds 1 post or 20 (no N+1), and a post must not re-read
   * what its access check already loaded (that duplication was 4 of 12 queries).
   */
  it('keeps reads within a fixed query budget, whatever the page size', async () => {
    const reader = await world.user('reader');
    const author = await world.user('author');
    await as(reader).put(`/users/${author.id}/follow`);
    const first = await world.post(author, 'first');
    const db = mongoose.connection.db!;

    async function queriesFor(path: string): Promise<number> {
      await db.command({ profile: 0 });
      await db
        .collection('system.profile')
        .drop()
        .catch(() => undefined);
      await db.command({ profile: 2 });
      try {
        expect((await as(reader).get(path)).status).toBe(200);
      } finally {
        await db.command({ profile: 0 });
      }
      return db.collection('system.profile').countDocuments({ ns: { $not: /system\./ } });
    }

    expect(await queriesFor(`/posts/${first}`)).toBeLessThanOrEqual(8);
    const onePost = await queriesFor(`/users/${author.id}/posts`);
    expect(onePost).toBeLessThanOrEqual(8);

    for (let i = 0; i < 19; i++) await world.post(author, `post ${i}`);
    expect(await queriesFor(`/users/${author.id}/posts`)).toBe(onePost);
  });
});
