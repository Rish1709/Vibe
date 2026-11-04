import type { UserSearchResultDto } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { UserModel } from '../../src/modules/users/user.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createWorld, type TestUser } from '../helpers/world.js';

describe('user search', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  async function search(viewer: TestUser, q: string, limit?: number) {
    const params = new URLSearchParams({ q, ...(limit && { limit: String(limit) }) });
    const res = await as(viewer).get(`/search/users?${params.toString()}`);
    expect(res.status).toBe(200);
    return res.body.data as UserSearchResultDto[];
  }
  const handles = (results: UserSearchResultDto[]) => results.map((user) => user.username);

  it('matches username prefixes, with or without @, and ranks the exact handle first', async () => {
    const viewer = await world.user('viewer');
    await world.user('gracey', { displayName: 'Someone Else' });
    await world.user('grace', { displayName: 'Grace Hopper' });
    await world.user('bob');

    expect(handles(await search(viewer, 'grace'))).toEqual(['grace', 'gracey']);
    expect(handles(await search(viewer, '@GRA'))).toEqual(
      expect.arrayContaining(['grace', 'gracey']),
    );
    expect(await search(viewer, 'zzz')).toEqual([]);
  });

  it('matches the start of any word in the display name, ignoring case and accents', async () => {
    const viewer = await world.user('viewer');
    await world.user('ghopper', { displayName: 'Grace Brewster Hopper' });
    await world.user('jose', { displayName: 'José Álvarez' });

    expect(handles(await search(viewer, 'hop'))).toEqual(['ghopper']);
    expect(handles(await search(viewer, 'gr hop'))).toEqual(['ghopper']);
    expect(handles(await search(viewer, 'gr xyz'))).toEqual([]);
    expect(handles(await search(viewer, 'alvarez'))).toEqual(['jose']);
    // "ace" is inside "Grace", not at the start of a word.
    expect(await search(viewer, 'ace')).toEqual([]);
  });

  it('finds a private account and follows it by request, reflected in later searches', async () => {
    const viewer = await world.user('viewer');
    const priv = await world.user('privy', { isPrivate: true, displayName: 'Private Person' });

    const [found] = await search(viewer, 'privy');
    expect(found).toMatchObject({
      username: 'privy',
      isPrivate: true,
      viewer: { following: 'none' },
    });

    const follow = await as(viewer).put(`/users/${priv.id}/follow`);
    expect(follow.body.data).toEqual({ following: 'pending' });
    expect((await search(viewer, 'privy'))[0]?.viewer).toEqual({ following: 'pending' });

    const requests = (await as(priv).get('/users/me/follow-requests')).body.data as {
      id: string;
    }[];
    expect(requests).toHaveLength(1);
    const accepted = await as(priv).post(`/users/me/follow-requests/${requests[0]?.id}/accept`);
    expect(accepted.status).toBe(204);
    expect((await search(viewer, 'privy'))[0]?.viewer).toEqual({ following: 'active' });
  });

  it('leaves out accounts blocked either way, and lists the viewer without a follow state', async () => {
    const viewer = await world.user('sam');
    const blocker = await world.user('samblocker');
    const blocked = await world.user('samblocked');
    await world.user('samfriend');
    expect((await as(blocker).put(`/users/${viewer.id}/block`)).status).toBe(204);
    expect((await as(viewer).put(`/users/${blocked.id}/block`)).status).toBe(204);

    const results = await search(viewer, 'sam');
    expect(handles(results)).toEqual(['sam', 'samfriend']);
    expect(results[0]?.viewer).toBeUndefined();
  });

  it('finds users by their new name after a rename, and no longer by the old one', async () => {
    const viewer = await world.user('viewer');
    const user = await world.user('renamer', { displayName: 'Old Name' });
    expect((await as(user).patch('/users/me', { displayName: 'Ada Lovelace' })).status).toBe(200);

    expect(handles(await search(viewer, 'lovelace'))).toEqual(['renamer']);
    expect(await search(viewer, 'old')).toEqual([]);
  });

  it('treats regex characters literally and validates the query', async () => {
    const viewer = await world.user('viewer');
    // Display names that don't start with "a", so only the handle can match.
    await world.user('a.b', { displayName: 'Dot' });
    await world.user('axb', { displayName: 'Cross' });

    expect(handles(await search(viewer, 'a.'))).toEqual(['a.b']);
    expect(await search(viewer, '(*')).toEqual([]);
    expect((await as(viewer).get('/search/users?q=')).status).toBe(400);
    expect((await as(viewer).get('/search/users?q=a&limit=500')).status).toBe(400);
  });

  it('respects the limit', async () => {
    const viewer = await world.user('viewer');
    for (const name of ['kim1', 'kim2', 'kim3']) await world.user(name);
    expect(await search(viewer, 'kim', 2)).toHaveLength(2);
  });

  it('runs both lookups as index scans, not collection scans', async () => {
    await UserModel.init();
    const plans = await Promise.all([
      UserModel.find({ deletedAt: null, username: /^gra/ }).explain('queryPlanner'),
      UserModel.find({
        deletedAt: null,
        username: { $type: 'string' },
        searchTokens: { $all: [/^hop/] },
      }).explain('queryPlanner'),
    ]);
    for (const plan of plans) {
      const winning = JSON.stringify((plan as unknown as { queryPlanner: unknown }).queryPlanner);
      expect(winning).toContain('IXSCAN');
      expect(winning).not.toContain('COLLSCAN');
    }
  });
});
