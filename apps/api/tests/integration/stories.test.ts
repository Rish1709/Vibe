import { describe, expect, it } from 'vitest';
import { MediaModel } from '../../src/modules/media/media.model.js';
import { StoryModel, StoryViewModel } from '../../src/modules/stories/story.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createTestMediaProvider, uploadMedia } from '../helpers/media.js';
import { createWorld, type TestUser } from '../helpers/world.js';

describe('stories', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const media = createTestMediaProvider();
  const world = createWorld(redis, { mediaProvider: media.provider });
  const { as } = world;

  async function postStory(author: TestUser, caption?: string) {
    const mediaId = await uploadMedia(as(author), media, { purpose: 'story' });
    const res = await as(author).post('/stories', { mediaId, ...(caption && { caption }) });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  const tray = async (viewer: TestUser) =>
    (await as(viewer).get('/stories/tray')).body.data as {
      author: { username: string };
      stories: { id: string; viewer: { seen: boolean } }[];
      hasUnseen: boolean;
    }[];

  it('shows a followee’s story as unseen until viewed', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await as(alice).put(`/users/${bob.id}/follow`);
    const storyId = await postStory(bob, 'beach day');

    let groups = await tray(alice);
    expect(groups.map((g) => g.author.username)).toEqual(['bob']);
    expect(groups[0]?.hasUnseen).toBe(true);

    expect((await as(alice).post(`/stories/${storyId}/views`)).status).toBe(200);
    groups = await tray(alice);
    expect(groups[0]).toMatchObject({
      hasUnseen: false,
      stories: [{ id: storyId, viewer: { seen: true } }],
    });
  });

  it('puts the viewer first, then unseen rings, then seen ones', async () => {
    const [me, seen, fresh] = [
      await world.user('me_user'),
      await world.user('seen_one'),
      await world.user('fresh_one'),
    ];
    await as(me).put(`/users/${seen.id}/follow`);
    await as(me).put(`/users/${fresh.id}/follow`);
    const seenStory = await postStory(seen);
    await postStory(fresh);
    await postStory(me);
    await as(me).post(`/stories/${seenStory}/views`);
    expect((await tray(me)).map((g) => g.author.username)).toEqual([
      'me_user',
      'fresh_one',
      'seen_one',
    ]);
  });

  it('counts each viewer once, under concurrency, and never the author', async () => {
    const author = await world.user('author');
    const storyId = await postStory(author);
    const viewers = await Promise.all([1, 2, 3].map((i) => world.user(`viewer${i}`)));
    await Promise.all(
      viewers.flatMap((v) => [
        as(v).post(`/stories/${storyId}/views`),
        as(v).post(`/stories/${storyId}/views`),
      ]),
    );
    await as(author).post(`/stories/${storyId}/views`);

    expect(await StoryViewModel.countDocuments({ storyId })).toBe(3);
    expect((await StoryModel.findById(storyId).lean())?.viewCount).toBe(3);
  });

  it('shows the viewer list only to the author', async () => {
    const [author, fan] = [await world.user('author'), await world.user('fan')];
    const storyId = await postStory(author);
    await as(fan).post(`/stories/${storyId}/views`);

    const list = await as(author).get(`/stories/${storyId}/viewers`);
    expect(list.body.data.map((u: { username: string }) => u.username)).toEqual(['fan']);
    expect((await as(fan).get(`/stories/${storyId}/viewers`)).status).toBe(404);
  });

  it('hides expired stories even before the TTL index deletes them', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await as(alice).put(`/users/${bob.id}/follow`);
    const storyId = await postStory(bob);
    await StoryModel.updateOne(
      { _id: storyId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    expect(await StoryModel.exists({ _id: storyId })).not.toBeNull(); // TTL hasn't run
    expect(await tray(alice)).toEqual([]);
    expect((await as(alice).get(`/users/${bob.id}/stories`)).body.data).toEqual([]);
    expect((await as(alice).post(`/stories/${storyId}/views`)).status).toBe(404);
    expect((await as(bob).get(`/stories/${storyId}/viewers`)).status).toBe(404);
  });

  it('keeps private accounts’ stories from non-followers and blocked users', async () => {
    const [priv, stranger, follower] = [
      await world.user('priv', { isPrivate: true }),
      await world.user('stranger'),
      await world.user('follower'),
    ];
    const storyId = await postStory(priv);

    expect((await as(stranger).get(`/users/${priv.id}/stories`)).status).toBe(403);
    expect((await as(stranger).post(`/stories/${storyId}/views`)).status).toBe(404);

    await as(follower).put(`/users/${priv.id}/follow`);
    const [request] = (await as(priv).get('/users/me/follow-requests')).body.data;
    await as(priv).post(`/users/me/follow-requests/${request.id}/accept`);
    expect((await tray(follower)).map((g) => g.author.username)).toEqual(['priv']);

    await as(priv).put(`/users/${follower.id}/block`);
    expect(await tray(follower)).toEqual([]);
    expect((await as(follower).post(`/stories/${storyId}/views`)).status).toBe(404);
  });

  it('lets only the author delete, and releases the media', async () => {
    const [author, other] = [await world.user('author'), await world.user('other')];
    const storyId = await postStory(author);
    expect((await as(other).delete(`/stories/${storyId}`)).status).toBe(404);
    expect((await as(author).delete(`/stories/${storyId}`)).status).toBe(204);

    expect(await tray(author)).toEqual([]);
    const story = await StoryModel.findById(storyId).lean();
    expect((await MediaModel.findById(story?.media.mediaId).lean())?.status).toBe('released');
  });

  it('requires story media (not a post upload)', async () => {
    const author = await world.user('author');
    const postMedia = await uploadMedia(as(author), media, { purpose: 'post' });
    expect((await as(author).post('/stories', { mediaId: postMedia })).status).toBe(400);
  });
});
