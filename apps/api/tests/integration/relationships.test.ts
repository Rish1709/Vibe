import { describe, expect, it } from 'vitest';
import { BlockModel } from '../../src/modules/relationships/block.model.js';
import { FollowModel } from '../../src/modules/relationships/follow.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createWorld } from '../helpers/world.js';

describe('follows', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  it('follows a public account immediately and updates both counters', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const res = await as(alice).put(`/users/${bob.id}/follow`);
    expect(res.body.data).toEqual({ following: 'active' });

    expect((await world.profile(alice, 'alice')).counts.following).toBe(1);
    expect((await world.profile(alice, 'bob')).counts.followers).toBe(1);
    const view = (await as(alice).get('/users/bob')).body.data;
    expect(view.viewer).toEqual({ following: 'active', followedBy: false, blocking: false });
  });

  it('is idempotent under concurrent duplicate follows', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const results = await Promise.all(
      Array.from({ length: 15 }, () => as(alice).put(`/users/${bob.id}/follow`)),
    );
    expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
    expect(await FollowModel.countDocuments({ followeeId: bob.id })).toBe(1);
    expect((await world.profile(bob, 'bob')).counts.followers).toBe(1);
  });

  it('unfollows idempotently without driving counters negative', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await as(alice).put(`/users/${bob.id}/follow`);
    await Promise.all([
      as(alice).delete(`/users/${bob.id}/follow`),
      as(alice).delete(`/users/${bob.id}/follow`),
    ]);
    await as(alice).delete(`/users/${bob.id}/follow`);
    expect((await world.profile(bob, 'bob')).counts.followers).toBe(0);
    expect((await world.profile(alice, 'alice')).counts.following).toBe(0);
  });

  it('rejects following yourself and nonexistent users', async () => {
    const alice = await world.user('alice');
    expect((await as(alice).put(`/users/${alice.id}/follow`)).status).toBe(400);
    expect((await as(alice).put('/users/65a1b2c3d4e5f60718293a4b/follow')).status).toBe(404);
    expect((await as(alice).put('/users/not-an-id/follow')).status).toBe(400);
  });

  describe('private accounts', () => {
    it('creates a pending request that only the owner can accept', async () => {
      const [alice, priv, mallory] = [
        await world.user('alice'),
        await world.user('priv', { isPrivate: true }),
        await world.user('mallory'),
      ];
      expect((await as(alice).put(`/users/${priv.id}/follow`)).body.data).toEqual({
        following: 'pending',
      });
      expect((await world.profile(priv, 'priv')).counts.followers).toBe(0);

      const requests = (await as(priv).get('/users/me/follow-requests')).body.data;
      expect(requests).toHaveLength(1);
      const requestId = requests[0].id as string;

      // Someone else cannot accept a request addressed to priv.
      expect((await as(mallory).post(`/users/me/follow-requests/${requestId}/accept`)).status).toBe(
        404,
      );

      const accepted = await Promise.all([
        as(priv).post(`/users/me/follow-requests/${requestId}/accept`),
        as(priv).post(`/users/me/follow-requests/${requestId}/accept`),
      ]);
      expect(accepted.map((r) => r.status).sort()).toEqual([204, 404]);
      expect((await world.profile(priv, 'priv')).counts.followers).toBe(1);
    });

    it('hides content and follower lists until the request is accepted', async () => {
      const [alice, priv] = [
        await world.user('alice'),
        await world.user('priv', { isPrivate: true }),
      ];
      const postId = await world.post(priv, 'secret thoughts');

      const profile = (await as(alice).get('/users/priv')).body.data;
      expect(profile).toMatchObject({ isPrivate: true, canViewContent: false });
      expect((await as(alice).get(`/users/${priv.id}/posts`)).status).toBe(403);
      expect((await as(alice).get(`/users/${priv.id}/followers`)).status).toBe(403);
      // Existence of the post is not revealed.
      expect((await as(alice).get(`/posts/${postId}`)).status).toBe(404);

      await as(alice).put(`/users/${priv.id}/follow`);
      const [request] = (await as(priv).get('/users/me/follow-requests')).body.data;
      await as(priv).post(`/users/me/follow-requests/${request.id}/accept`);

      expect((await as(alice).get(`/posts/${postId}`)).status).toBe(200);
      expect((await as(alice).get(`/users/${priv.id}/posts`)).body.data).toHaveLength(1);
    });

    it('lets the owner decline a request and remove a follower', async () => {
      const [alice, bob, priv] = [
        await world.user('alice'),
        await world.user('bob'),
        await world.user('priv', { isPrivate: true }),
      ];
      await as(alice).put(`/users/${priv.id}/follow`);
      const [request] = (await as(priv).get('/users/me/follow-requests')).body.data;
      expect((await as(priv).delete(`/users/me/follow-requests/${request.id}`)).status).toBe(204);
      expect(await FollowModel.countDocuments({ followeeId: priv.id })).toBe(0);

      await as(priv).patch('/users/me/settings', { isPrivate: false });
      await as(bob).put(`/users/${priv.id}/follow`);
      expect((await as(priv).delete(`/users/${bob.id}/follower`)).status).toBe(204);
      expect((await world.profile(priv, 'priv')).counts.followers).toBe(0);
    });
  });

  it('paginates followers newest first with the viewer’s follow state', async () => {
    const target = await world.user('target');
    const viewer = await world.user('viewer');
    const followers = [];
    for (let i = 0; i < 5; i++) {
      const follower = await world.user(`fan${i}`);
      await as(follower).put(`/users/${target.id}/follow`);
      followers.push(follower);
    }
    await as(viewer).put(`/users/${followers[4]?.id}/follow`);

    const first = await as(viewer).get(`/users/${target.id}/followers?limit=3`);
    expect(first.body.data.map((u: { username: string }) => u.username)).toEqual([
      'fan4',
      'fan3',
      'fan2',
    ]);
    expect(first.body.data[0].viewer).toEqual({ following: 'active' });
    expect(first.body.meta.nextCursor).toEqual(expect.any(String));

    const second = await as(viewer).get(
      `/users/${target.id}/followers?limit=3&cursor=${first.body.meta.nextCursor}`,
    );
    expect(second.body.data.map((u: { username: string }) => u.username)).toEqual(['fan1', 'fan0']);
    expect(second.body.meta.nextCursor).toBeNull();
  });
});

describe('blocks', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  it('removes follows in both directions and fixes all four counters', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await as(alice).put(`/users/${bob.id}/follow`);
    await as(bob).put(`/users/${alice.id}/follow`);

    expect((await as(alice).put(`/users/${bob.id}/block`)).status).toBe(204);
    expect(await FollowModel.countDocuments({})).toBe(0);
    const [a, b] = [await world.profile(alice, 'alice'), await world.profile(alice, 'bob')];
    expect(a.counts).toMatchObject({ followers: 0, following: 0 });
    expect(b.counts).toMatchObject({ followers: 0, following: 0 });
  });

  it('makes the blocker invisible to the blocked user, and prevents re-following', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    const postId = await world.post(alice, 'hello');
    await as(alice).put(`/users/${bob.id}/block`);

    expect((await as(bob).get('/users/alice')).status).toBe(404);
    expect((await as(bob).get(`/posts/${postId}`)).status).toBe(404);
    expect((await as(bob).put(`/users/${alice.id}/follow`)).status).toBe(404);
    // The blocker still sees the profile (to unblock) but not as followable.
    const view = (await as(alice).get('/users/bob')).body.data;
    expect(view.viewer.blocking).toBe(true);
    expect((await as(alice).put(`/users/${bob.id}/follow`)).status).toBe(403);
  });

  it('is idempotent, listable, and reversible without restoring follows', async () => {
    const [alice, bob] = [await world.user('alice'), await world.user('bob')];
    await as(alice).put(`/users/${bob.id}/follow`);
    await Promise.all([
      as(alice).put(`/users/${bob.id}/block`),
      as(alice).put(`/users/${bob.id}/block`),
    ]);
    expect(await BlockModel.countDocuments({})).toBe(1);
    expect(
      (await as(alice).get('/users/me/blocks')).body.data.map((u: { id: string }) => u.id),
    ).toEqual([bob.id]);

    expect((await as(alice).delete(`/users/${bob.id}/block`)).status).toBe(204);
    expect((await as(bob).get('/users/alice')).status).toBe(200);
    expect(await FollowModel.countDocuments({})).toBe(0);
  });

  it('never leaves a follow edge when follow and block race', async () => {
    for (let round = 0; round < 30; round++) {
      const [alice, bob] = [await world.user(`a_${round}`), await world.user(`b_${round}`)];
      await Promise.all([
        as(bob).put(`/users/${alice.id}/follow`),
        as(alice).put(`/users/${bob.id}/block`),
      ]);
      expect(await FollowModel.countDocuments({ followerId: bob.id, followeeId: alice.id })).toBe(
        0,
      );
      expect((await world.profile(alice, `a_${round}`)).counts.followers).toBe(0);
    }
    // Thirty independent races: each round is a fresh pair, so interleavings vary.
  }, 60_000);
});
