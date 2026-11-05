import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommentModel } from '../../src/modules/comments/comment.model.js';
import { BookmarkModel, LikeModel } from '../../src/modules/engagement/engagement.models.js';
import { createCounterReconciler } from '../../src/modules/maintenance/counter.reconcile.js';
import { createRecordingMaintenanceQueue } from '../../src/modules/maintenance/maintenance.queue.js';
import { createPostCascade } from '../../src/modules/maintenance/post.cascade.js';
import { NotificationModel } from '../../src/modules/notifications/notification.model.js';
import { createNotificationProcessor } from '../../src/modules/notifications/notification.processor.js';
import {
  createNotificationQueue,
  NOTIFICATIONS_QUEUE,
  type NotificationQueue,
} from '../../src/modules/notifications/notification.queue.js';
import { PostModel } from '../../src/modules/posts/post.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { createRecordingPublisher } from '../../src/realtime/publisher.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { silentLogger } from '../helpers/testApp.js';
import { createWorld } from '../helpers/world.js';

const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';

describe('post cascade', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const maintenance = createRecordingMaintenanceQueue();
  const world = createWorld(redis, { maintenanceQueue: maintenance });
  const { as } = world;
  const cascade = createPostCascade({ logger: silentLogger });

  it('queues cleanup on delete, then removes likes, bookmarks, comments and notifications', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const postId = await world.post(author, 'doomed');
    const keeper = await world.post(author, 'stays');
    for (const id of [postId, keeper]) {
      await as(fan).put(`/posts/${id}/like`);
      await as(fan).put(`/posts/${id}/bookmark`);
      await as(fan).post(`/posts/${id}/comments`, { text: 'nice' });
    }
    await NotificationModel.create({
      recipientId: author.id,
      actorId: fan.id,
      type: 'like',
      postId,
      dedupeKey: `like-${fan.id}-${postId}-`,
    });

    expect((await as(author).delete(`/posts/${postId}`)).status).toBe(204);
    expect(maintenance.cascades).toEqual([postId]);

    const result = await cascade(postId);
    expect(result).toEqual({
      skipped: false,
      removed: { likes: 1, bookmarks: 1, comments: 1, notifications: 1 },
    });
    // The other post is untouched, and a retry finds nothing left.
    const keep = { postId: new Types.ObjectId(keeper) };
    expect(await LikeModel.countDocuments(keep)).toBe(1);
    expect(await BookmarkModel.countDocuments(keep)).toBe(1);
    expect(await CommentModel.countDocuments(keep)).toBe(1);
    expect((await cascade(postId)).removed).toEqual({
      likes: 0,
      bookmarks: 0,
      comments: 0,
      notifications: 0,
    });
  });

  it('refuses to touch a post that is not deleted', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const postId = await world.post(author, 'alive');
    await as(fan).put(`/posts/${postId}/like`);
    expect(await cascade(postId)).toEqual({ skipped: true });
    expect(await LikeModel.countDocuments()).toBe(1);
  });
});

describe('counter reconciliation', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  const countsOf = async (userId: string) =>
    (await UserModel.findById(userId, { counts: 1 }).lean())?.counts;
  const postCounts = async (postId: string) =>
    (await PostModel.findById(postId, { counts: 1 }).lean())?.counts;

  it('repairs drifted user and post counters to what the edges say', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    await as(ben).put(`/users/${ann.id}/follow`);
    const postId = await world.post(ann, 'hello');
    await as(ben).put(`/posts/${postId}/like`);
    const top = await as(ben).post(`/posts/${postId}/comments`, { text: 'top' });
    await as(ann).post(`/posts/${postId}/comments`, { text: 'reply', parentId: top.body.data.id });

    const truth = { user: await countsOf(ann.id), post: await postCounts(postId) };
    expect(truth.post).toMatchObject({ likes: 1, comments: 2 });

    // Simulate a crash between edge writes and their $incs.
    await UserModel.updateOne(
      { _id: ann.id },
      { $set: { counts: { followers: 9, following: 4, posts: 0 } } },
    );
    await PostModel.updateOne(
      { _id: postId },
      { $set: { counts: { likes: 0, comments: 7, reposts: 3 } } },
    );

    const reconcile = createCounterReconciler({
      logger: silentLogger,
      settle: () => Promise.resolve(),
    });
    const result = await reconcile();
    expect(result.users).toMatchObject({ drifted: 1, fixed: 1 });
    expect(result.posts).toMatchObject({ drifted: 1, fixed: 1 });
    expect(await countsOf(ann.id)).toEqual(truth.user);
    expect(await postCounts(postId)).toEqual(truth.post);

    // Nothing left to do on a second run.
    const again = await reconcile();
    expect(again.users.fixed + again.posts.fixed).toBe(0);
  });

  it('counts replies only while their thread is alive, matching the live delete rule', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const postId = await world.post(ann, 'thread');
    const top = await as(ben).post(`/posts/${postId}/comments`, { text: 'top' });
    await as(ann).post(`/posts/${postId}/comments`, { text: 'r1', parentId: top.body.data.id });
    await as(ann).post(`/posts/${postId}/comments`, { text: 'r2', parentId: top.body.data.id });
    await as(ben).delete(`/comments/${top.body.data.id as string}`);
    expect((await postCounts(postId))?.comments).toBe(0);

    const reconcile = createCounterReconciler({
      logger: silentLogger,
      settle: () => Promise.resolve(),
    });
    const result = await reconcile();
    // The live counters were already right: nothing is "corrected" into a wrong value.
    expect(result.posts.fixed).toBe(0);
    expect((await postCounts(postId))?.comments).toBe(0);
  });

  it('leaves a counter alone if it changes between the two measurements', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const postId = await world.post(ann, 'busy');
    await PostModel.updateOne({ _id: postId }, { $set: { 'counts.likes': 5 } }); // drifted

    // A like lands while the reconciler waits: the post is busy, so it must be skipped this run.
    const reconcile = createCounterReconciler({
      logger: silentLogger,
      settle: () => as(ben).put(`/posts/${postId}/like`),
    });
    const result = await reconcile();
    expect(result.posts).toMatchObject({ drifted: 0, fixed: 0 });
    expect((await postCounts(postId))?.likes).toBe(6);

    // Once quiet, the next run repairs it.
    await createCounterReconciler({ logger: silentLogger, settle: () => Promise.resolve() })();
    expect((await postCounts(postId))?.likes).toBe(1);
  });
});

describe('notification jobs through real BullMQ', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const prefix = `test-${randomUUID().slice(0, 8)}`;
  const connections = [0, 1, 2].map(
    () => new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true }),
  );
  const [producer, inspectorConn, workerConn] = connections as [Redis, Redis, Redis];
  let queue: NotificationQueue;
  let inspector: Queue;
  let worker: Worker;
  const pushes = createRecordingPublisher();

  const forwarding: NotificationQueue = {
    enqueue: (event) => queue.enqueue(event),
    close: () => Promise.resolve(),
  };
  const world = createWorld(redis, { notificationQueue: forwarding });
  const { as } = world;

  beforeAll(async () => {
    await Promise.all(connections.map((c) => c.connect()));
    queue = createNotificationQueue(producer, prefix);
    inspector = new Queue(NOTIFICATIONS_QUEUE, { connection: inspectorConn, prefix });
    worker = new Worker(
      NOTIFICATIONS_QUEUE,
      createNotificationProcessor({ realtime: pushes.publisher, logger: silentLogger }),
      { connection: workerConn, prefix },
    );
  });
  afterAll(async () => {
    await worker.close();
    await inspector.obliterate({ force: true });
    await Promise.all([queue.close(), inspector.close()]);
    await Promise.all(connections.map((c) => c.quit()));
  });

  it('really runs: a like becomes a stored notification and a live push', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const postId = await world.post(author, 'post');
    await as(fan).put(`/posts/${postId}/like`);

    const deadline = Date.now() + 10_000;
    // The push is the job's last step, so waiting for it means the job has fully run.
    while (pushes.sent.length === 0) {
      if (Date.now() > deadline) throw new Error('notification job never ran');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await inspector.getJobCounts('failed')).failed).toBe(0);
    expect(pushes.sent).toEqual([
      { userId: author.id, event: 'notification:new', payload: { type: 'like', unreadCount: 1 } },
    ]);
  });
});
