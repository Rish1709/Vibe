import type { NotificationDto, UnreadCountsDto } from '@vibe/shared';
import { describe, expect, it, vi } from 'vitest';
import { NotificationModel } from '../../src/modules/notifications/notification.model.js';
import { createNotificationProcessor } from '../../src/modules/notifications/notification.processor.js';
import { createRecordingNotificationQueue } from '../../src/modules/notifications/notification.queue.js';
import { createRecordingPublisher } from '../../src/realtime/publisher.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { silentLogger } from '../helpers/testApp.js';
import { createWorld, type TestUser } from '../helpers/world.js';

describe('notifications', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const queue = createRecordingNotificationQueue();
  const apiPushes = createRecordingPublisher();
  const world = createWorld(redis, { notificationQueue: queue, realtime: apiPushes.publisher });
  const { as } = world;
  const workerPushes = createRecordingPublisher();
  const processor = createNotificationProcessor({
    realtime: workerPushes.publisher,
    logger: silentLogger,
  });

  /** Plays the worker: processes everything queued so far. */
  async function deliver() {
    // notify() enqueues without awaiting; let those promises settle first.
    await new Promise((resolve) => setImmediate(resolve));
    const events = queue.events.splice(0);
    const outcomes = [];
    for (const event of events) outcomes.push(await processor.process(event));
    return outcomes;
  }
  async function list(user: TestUser) {
    const res = await as(user).get('/notifications');
    expect(res.status).toBe(200);
    return res.body.data as NotificationDto[];
  }
  async function unread(user: TestUser) {
    return ((await as(user).get('/notifications/unread-counts')).body.data as UnreadCountsDto)
      .notifications;
  }

  it('notifies the author of a like, once, with the post and a live count', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const postId = await world.post(author, 'a lovely post');
    workerPushes.sent.length = 0;

    await as(fan).put(`/posts/${postId}/like`);
    await as(fan).put(`/posts/${postId}/like`); // idempotent: no second event
    expect(await deliver()).toEqual(['created']);

    const [item] = await list(author);
    expect(item).toMatchObject({
      type: 'like',
      actor: { username: 'fan' },
      post: { id: postId, text: 'a lovely post' },
      read: false,
    });
    expect(workerPushes.sent).toEqual([
      { userId: author.id, event: 'notification:new', payload: { type: 'like', unreadCount: 1 } },
    ]);
  });

  it('is idempotent: a retried job, or like/unlike/like, leaves one notification', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const postId = await world.post(author, 'post');

    await as(fan).put(`/posts/${postId}/like`);
    await new Promise((resolve) => setImmediate(resolve));
    const [event] = queue.events.splice(0);
    if (!event) throw new Error('expected a queued event');
    expect(await processor.process(event)).toBe('created');
    expect(await processor.process(event)).toBe('duplicate'); // BullMQ retry

    await as(fan).delete(`/posts/${postId}/like`);
    await as(fan).put(`/posts/${postId}/like`);
    expect(await deliver()).toEqual(['created']);
    expect(await NotificationModel.countDocuments()).toBe(1);
  });

  it('withdraws the notification when the like is undone, before or after processing', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const postId = await world.post(author, 'post');

    // Undone before the worker ran: the job finds nothing to notify about.
    await as(fan).put(`/posts/${postId}/like`);
    await as(fan).delete(`/posts/${postId}/like`);
    expect(await deliver()).toEqual(['skipped']);

    // Undone after: the API removes it and pushes the corrected count.
    await as(fan).put(`/posts/${postId}/like`);
    await deliver();
    expect(await unread(author)).toBe(1);
    apiPushes.sent.length = 0;
    await as(fan).delete(`/posts/${postId}/like`);
    expect(await list(author)).toEqual([]);
    expect(apiPushes.sent).toEqual([
      { userId: author.id, event: 'notification:count', payload: { unreadCount: 0 } },
    ]);
  });

  it('survives the undo racing the worker between its insert and its re-check', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const postId = await world.post(author, 'post');
    await as(fan).put(`/posts/${postId}/like`);
    await new Promise((resolve) => setImmediate(resolve));
    const [event] = queue.events.splice(0);
    if (!event) throw new Error('expected a queued event');

    // The worst interleaving, made deterministic: the unlike (edge delete, then retract) lands right
    // after the worker inserted the notification and before it re-checks the like.
    const insert = NotificationModel.updateOne.bind(NotificationModel);
    const spy = vi.spyOn(NotificationModel, 'updateOne').mockImplementationOnce(((
      ...args: Parameters<typeof insert>
    ) =>
      insert(...args).then(async (result) => {
        await as(fan).delete(`/posts/${postId}/like`);
        return result;
      })) as typeof insert);
    try {
      expect(await processor.process(event)).toBe('retracted');
    } finally {
      spy.mockRestore();
    }
    expect(await NotificationModel.countDocuments()).toBe(0);
  });

  it('notifies about comments and replies to the right people', async () => {
    const author = await world.user('author');
    const commenter = await world.user('commenter');
    const replier = await world.user('replier');
    const postId = await world.post(author, 'post');

    const top = await as(commenter).post(`/posts/${postId}/comments`, { text: 'first!' });
    await deliver();
    await as(replier).post(`/posts/${postId}/comments`, {
      text: 'agreed',
      parentId: top.body.data.id as string,
    });
    await deliver();

    expect((await list(commenter)).map((n) => [n.type, n.actor.username, n.comment?.text])).toEqual(
      [['reply', 'replier', 'agreed']],
    );
    expect((await list(author)).map((n) => [n.type, n.actor.username])).toEqual([
      ['comment', 'replier'],
      ['comment', 'commenter'],
    ]);

    // Deleting a comment withdraws the notification about it (the reply's notifications stay).
    expect((await as(commenter).delete(`/comments/${top.body.data.id as string}`)).status).toBe(
      204,
    );
    expect((await list(author)).map((n) => n.actor.username)).toEqual(['replier']);
  });

  it('follows, requests and accepts: each side hears the right thing', async () => {
    const pub = await world.user('pub');
    const priv = await world.user('priv', { isPrivate: true });
    const fan = await world.user('fan');

    await as(fan).put(`/users/${pub.id}/follow`);
    await as(fan).put(`/users/${priv.id}/follow`);
    await deliver();
    expect((await list(pub)).map((n) => n.type)).toEqual(['follow']);
    expect((await list(priv)).map((n) => n.type)).toEqual(['follow_request']);

    const [request] = (await as(priv).get('/users/me/follow-requests')).body.data as {
      id: string;
    }[];
    await as(priv).post(`/users/me/follow-requests/${request?.id}/accept`);
    await deliver();
    // The answered request leaves priv's list; fan hears back.
    expect(await list(priv)).toEqual([]);
    expect((await list(fan)).map((n) => [n.type, n.actor.username])).toEqual([
      ['follow_accept', 'priv'],
    ]);

    // Unfollowing withdraws "fan followed you".
    await as(fan).delete(`/users/${pub.id}/follow`);
    expect(await list(pub)).toEqual([]);
  });

  it('withdraws a declined or cancelled follow request', async () => {
    const priv = await world.user('priv', { isPrivate: true });
    const a = await world.user('aaa');
    const b = await world.user('bbb');
    await as(a).put(`/users/${priv.id}/follow`);
    await as(b).put(`/users/${priv.id}/follow`);
    await deliver();
    expect(await unread(priv)).toBe(2);

    await as(a).delete(`/users/${priv.id}/follow`); // cancelled
    const [request] = (await as(priv).get('/users/me/follow-requests')).body.data as {
      id: string;
    }[];
    await as(priv).delete(`/users/me/follow-requests/${request?.id}`); // declined
    expect(await list(priv)).toEqual([]);
  });

  it('never notifies yourself, nor across a block', async () => {
    const author = await world.user('author');
    const troll = await world.user('troll');
    const postId = await world.post(author, 'post');

    await as(author).put(`/posts/${postId}/like`);
    expect(queue.events.filter((e) => e.actorId === author.id)).toEqual([]);

    await as(troll).put(`/posts/${postId}/like`);
    await new Promise((resolve) => setImmediate(resolve));
    expect((await as(author).put(`/users/${troll.id}/block`)).status).toBe(204);
    expect(await deliver()).toEqual(['skipped']);
    expect(await list(author)).toEqual([]);
  });

  it('hides notifications whose actor was blocked later, or whose post was deleted', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    const other = await world.user('other');
    const postId = await world.post(author, 'post');
    await as(fan).put(`/posts/${postId}/like`);
    await as(other).put(`/users/${author.id}/follow`);
    await deliver();
    expect(await list(author)).toHaveLength(2);

    await as(author).put(`/users/${other.id}/block`);
    expect((await list(author)).map((n) => n.type)).toEqual(['like']);
    await as(author).delete(`/posts/${postId}`);
    expect(await list(author)).toEqual([]);
  });

  it('marks all read, and the badge clears in other tabs', async () => {
    const author = await world.user('author');
    const fan = await world.user('fan');
    await as(fan).put(`/users/${author.id}/follow`);
    await deliver();
    expect(await unread(author)).toBe(1);

    apiPushes.sent.length = 0;
    expect((await as(author).post('/notifications/read')).status).toBe(204);
    expect(await unread(author)).toBe(0);
    expect((await list(author))[0]?.read).toBe(true);
    expect(apiPushes.sent).toEqual([
      { userId: author.id, event: 'notification:count', payload: { unreadCount: 0 } },
    ]);
  });
});
