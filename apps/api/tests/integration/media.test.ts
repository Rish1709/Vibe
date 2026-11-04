import { createHmac } from 'node:crypto';
import type { UploadTicketDto } from '@vibe/shared';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { MediaProviderUnavailableError } from '../../src/infra/imagekit.js';
import { createMediaCleanup } from '../../src/modules/media/media.cleanup.js';
import { MediaModel } from '../../src/modules/media/media.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import {
  createTestMediaProvider,
  TEST_IMAGEKIT_PRIVATE_KEY,
  uploadMedia,
} from '../helpers/media.js';
import { silentLogger } from '../helpers/testApp.js';
import { createWorld, type TestUser } from '../helpers/world.js';

describe('media uploads', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const media = createTestMediaProvider();
  const world = createWorld(redis, { mediaProvider: media.provider });
  const { as } = world;

  async function ticketFor(
    user: TestUser,
    body: object = { purpose: 'post', mimeType: 'image/jpeg', size: 200_000 },
  ) {
    const res = await as(user).post('/media/uploads', body);
    expect(res.status).toBe(201);
    return res.body.data as UploadTicketDto;
  }

  it('issues a correctly signed ticket scoped to the user’s folder', async () => {
    const alice = await world.user('alice');
    const ticket = await ticketFor(alice);

    expect(ticket.fields.folder).toBe(`/vibe/users/${alice.id}/post`);
    expect(ticket.fields.fileName).toBe(ticket.mediaId);
    const expected = createHmac('sha1', TEST_IMAGEKIT_PRIVATE_KEY)
      .update(ticket.fields.token + ticket.fields.expire)
      .digest('hex');
    expect(ticket.fields.signature).toBe(expected);
    expect(JSON.stringify(ticket)).not.toContain(TEST_IMAGEKIT_PRIVATE_KEY);
  });

  it.each([
    [{ purpose: 'post', mimeType: 'application/pdf', size: 1000 }, 'a disallowed type'],
    [{ purpose: 'post', mimeType: 'image/jpeg', size: 11 * 1024 * 1024 }, 'an image over 10 MB'],
    [{ purpose: 'avatar', mimeType: 'video/mp4', size: 1000 }, 'a video avatar'],
    [{ purpose: 'post', mimeType: 'image/jpeg', size: 0 }, 'an empty file'],
    [{ purpose: 'banner', mimeType: 'image/jpeg', size: 1000 }, 'an unknown purpose'],
  ])('refuses to authorize %j (%s)', async (body) => {
    const alice = await world.user('alice');
    expect((await as(alice).post('/media/uploads', body)).status).toBe(400);
  });

  it('completes a well-formed upload and reports what was stored', async () => {
    const alice = await world.user('alice');
    const ticket = await ticketFor(alice);
    const fileId = media.store(ticket);
    const res = await as(alice).post(`/media/uploads/${ticket.mediaId}/complete`, { fileId });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: ticket.mediaId,
      kind: 'image',
      width: 1080,
      height: 1350,
    });
  });

  it.each([
    [
      'a file in another user’s folder',
      (t: UploadTicketDto) => ({
        filePath: `/vibe/users/${new Types.ObjectId().toHexString()}/post/${t.mediaId}.jpg`,
      }),
    ],
    [
      'a file named for a different upload',
      () => ({ name: `${new Types.ObjectId().toHexString()}.jpg` }),
    ],
    ['a file bigger than allowed', () => ({ size: 11 * 1024 * 1024 })],
    ['a video where an image was declared', () => ({ mimeType: 'video/mp4' })],
    ['a disallowed type', () => ({ mimeType: 'text/html' })],
  ])('rejects and deletes %s', async (_label, tamper) => {
    const alice = await world.user('alice');
    const ticket = await ticketFor(alice);
    const fileId = media.store(ticket, tamper(ticket));

    const res = await as(alice).post(`/media/uploads/${ticket.mediaId}/complete`, { fileId });
    expect(res.status).toBe(400);
    expect(media.deleted).toContain(fileId);
    expect(await MediaModel.exists({ _id: ticket.mediaId })).toBeNull();
  });

  it('does not let one user complete another user’s upload', async () => {
    const [alice, mallory] = [await world.user('alice'), await world.user('mallory')];
    const ticket = await ticketFor(alice);
    const fileId = media.store(ticket);
    expect(
      (await as(mallory).post(`/media/uploads/${ticket.mediaId}/complete`, { fileId })).status,
    ).toBe(404);
  });

  it('does not let a stored file back two uploads', async () => {
    const alice = await world.user('alice');
    const first = await ticketFor(alice);
    const fileId = media.store(first);
    expect(
      (await as(alice).post(`/media/uploads/${first.mediaId}/complete`, { fileId })).status,
    ).toBe(200);
    // Second ticket, same stored file, renamed to match: the unique fileId index refuses it.
    const second = await ticketFor(alice);
    const file = media.files.get(fileId);
    if (file)
      media.files.set(fileId, {
        ...file,
        name: `${second.mediaId}.jpg`,
        filePath: `${second.fields.folder}/${second.mediaId}.jpg`,
      });
    expect(
      (await as(alice).post(`/media/uploads/${second.mediaId}/complete`, { fileId })).status,
    ).toBe(409);
  });

  it('answers a retryable 503 when ImageKit is unreachable, keeping the upload completable', async () => {
    const alice = await world.user('alice');
    const ticket = await ticketFor(alice);
    const fileId = media.store(ticket);
    // Fails once, then ImageKit answers normally again.
    vi.spyOn(media.provider, 'getFile').mockRejectedValueOnce(
      new MediaProviderUnavailableError('ImageKit is unavailable'),
    );
    const res = await as(alice).post(`/media/uploads/${ticket.mediaId}/complete`, { fileId });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(media.deleted).not.toContain(fileId);
    expect((await MediaModel.findById(ticket.mediaId).lean())?.status).toBe('pending');

    const retry = await as(alice).post(`/media/uploads/${ticket.mediaId}/complete`, { fileId });
    expect(retry.status).toBe(200);
  });

  it('answers 503 when ImageKit is not configured', async () => {
    const unconfigured = createWorld(redis);
    const alice = await unconfigured.user('alice');
    const res = await unconfigured
      .as(alice)
      .post('/media/uploads', { purpose: 'post', mimeType: 'image/jpeg', size: 100 });
    expect(res.status).toBe(503);
  });
});

describe('posts and avatars with media', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const media = createTestMediaProvider();
  const world = createWorld(redis, { mediaProvider: media.provider });
  const { as } = world;

  it('creates a photo post (text optional) and embeds the media', async () => {
    const alice = await world.user('alice');
    const ids = [await uploadMedia(as(alice), media), await uploadMedia(as(alice), media)];
    const res = await as(alice).post('/posts', { mediaIds: ids });
    expect(res.status).toBe(201);
    expect(res.body.data.text).toBe('');
    expect(res.body.data.media.map((m: { id: string }) => m.id)).toEqual(ids);
    expect(await MediaModel.countDocuments({ _id: { $in: ids }, status: 'attached' })).toBe(2);
  });

  it('requires text or media', async () => {
    const alice = await world.user('alice');
    expect((await as(alice).post('/posts', {})).status).toBe(400);
    expect((await as(alice).post('/posts', { mediaIds: [] })).status).toBe(400);
  });

  it('lets each upload be used once, even by concurrent posts', async () => {
    const alice = await world.user('alice');
    const id = await uploadMedia(as(alice), media);
    const results = await Promise.all([
      as(alice).post('/posts', { mediaIds: [id], text: 'one' }),
      as(alice).post('/posts', { mediaIds: [id], text: 'two' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
  });

  it('refuses someone else’s upload and unfinished uploads', async () => {
    const [alice, mallory] = [await world.user('alice'), await world.user('mallory')];
    const alicesMedia = await uploadMedia(as(alice), media);
    expect((await as(mallory).post('/posts', { mediaIds: [alicesMedia] })).status).toBe(400);

    const pending = (
      await as(alice).post('/media/uploads', { purpose: 'post', mimeType: 'image/jpeg', size: 1 })
    ).body.data as UploadTicketDto;
    expect((await as(alice).post('/posts', { mediaIds: [pending.mediaId] })).status).toBe(400);
  });

  it('rejects mixing a video with photos and leaves the uploads usable', async () => {
    const alice = await world.user('alice');
    const video = await uploadMedia(as(alice), media, { mimeType: 'video/mp4', size: 5_000_000 });
    const photo = await uploadMedia(as(alice), media);
    expect((await as(alice).post('/posts', { mediaIds: [video, photo] })).status).toBe(400);
    expect(await MediaModel.countDocuments({ _id: { $in: [video, photo] }, status: 'ready' })).toBe(
      2,
    );
    expect((await as(alice).post('/posts', { mediaIds: [video] })).status).toBe(201);
  });

  it('releases a deleted post’s media for cleanup', async () => {
    const alice = await world.user('alice');
    const id = await uploadMedia(as(alice), media);
    const post = (await as(alice).post('/posts', { mediaIds: [id] })).body.data;
    await as(alice).delete(`/posts/${post.id}`);
    expect((await MediaModel.findById(id).lean())?.status).toBe('released');
  });

  it('sets, replaces and removes an avatar, releasing the old one', async () => {
    const alice = await world.user('alice');
    const first = await uploadMedia(as(alice), media, { purpose: 'avatar' });
    const set = await as(alice).patch('/users/me', { avatarMediaId: first });
    expect(set.status).toBe(200);
    expect(set.body.data.avatarUrl).toContain(first);

    const second = await uploadMedia(as(alice), media, { purpose: 'avatar' });
    await as(alice).patch('/users/me', { avatarMediaId: second });
    expect((await MediaModel.findById(first).lean())?.status).toBe('released');

    const removed = await as(alice).patch('/users/me', { avatarMediaId: null });
    expect(removed.body.data.avatarUrl).toBeNull();
    expect((await MediaModel.findById(second).lean())?.status).toBe('released');
  });

  it('refuses a post upload used as an avatar', async () => {
    const alice = await world.user('alice');
    const postMedia = await uploadMedia(as(alice), media, { purpose: 'post' });
    expect((await as(alice).patch('/users/me', { avatarMediaId: postMedia })).status).toBe(400);
  });
});

describe('media cleanup job', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const media = createTestMediaProvider();
  const world = createWorld(redis, { mediaProvider: media.provider });

  it('deletes abandoned, released and long-expired story media, and keeps everything else', async () => {
    const owner = await world.user('owner');
    const now = new Date();
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000);
    const make = (fields: object) =>
      MediaModel.create({
        ownerId: owner.id,
        purpose: 'post',
        kind: 'image',
        folder: '/f',
        fileId: `f_${new Types.ObjectId().toHexString()}`,
        ...fields,
      });

    const abandoned = await make({ status: 'pending', createdAt: hoursAgo(30) });
    const unusedReady = await make({ status: 'ready', createdAt: hoursAgo(30) });
    const released = await make({ status: 'released' });
    const oldStory = await make({ purpose: 'story', status: 'attached', attachedAt: hoursAgo(50) });
    const freshPending = await make({ status: 'pending', createdAt: hoursAgo(1) });
    const livePost = await make({ status: 'attached', attachedAt: hoursAgo(500) });
    const recentStory = await make({
      purpose: 'story',
      status: 'attached',
      attachedAt: hoursAgo(30),
    });

    const result = await createMediaCleanup({ provider: media.provider, logger: silentLogger })(
      now,
    );
    expect(result).toEqual({ deleted: 4, failed: 0 });
    for (const gone of [abandoned, unusedReady, released, oldStory]) {
      expect(media.deleted).toContain(gone.fileId);
      expect(await MediaModel.exists({ _id: gone._id })).toBeNull();
    }
    for (const kept of [freshPending, livePost, recentStory]) {
      expect(await MediaModel.exists({ _id: kept._id })).not.toBeNull();
    }
  });

  it('keeps the record for retry when the CDN delete fails', async () => {
    const owner = await world.user('owner');
    const record = await MediaModel.create({
      ownerId: owner.id,
      purpose: 'post',
      kind: 'image',
      folder: '/f',
      fileId: 'f_fail',
      status: 'released',
    });
    const failing = { ...media.provider, deleteFile: () => Promise.reject(new Error('CDN down')) };
    const result = await createMediaCleanup({ provider: failing, logger: silentLogger })();
    expect(result.failed).toBe(1);
    expect(await MediaModel.exists({ _id: record._id })).not.toBeNull();
  });
});
