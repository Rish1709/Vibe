import type { PostDto, SuggestedUserDto, TrendingHashtagDto } from '@vibe/shared';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { CacheKeys } from '../../src/cache/keys.js';
import { toTextSearch } from '../../src/modules/discovery/discovery.service.js';
import { PostModel } from '../../src/modules/posts/post.model.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createWorld, type TestUser } from '../helpers/world.js';

describe('discovery', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const world = createWorld(redis);
  const { as } = world;

  beforeEach(async () => {
    await redis.del(CacheKeys.trendingHashtags());
  });

  const texts = (posts: PostDto[]) => posts.map((post) => post.text);
  async function searchPosts(viewer: TestUser, q: string, extra = '') {
    const res = await as(viewer).get(`/search/posts?q=${encodeURIComponent(q)}${extra}`);
    expect(res.status).toBe(200);
    return res.body as { data: PostDto[]; meta: { nextCursor: string | null } };
  }

  describe('post search', () => {
    it('requires every word, ignores case, and keeps stop words meaningful', async () => {
      const ann = await world.user('ann');
      await world.post(ann, 'I love running in the park');
      await world.post(ann, 'running late again');
      await world.post(ann, 'The PARK is green');

      expect(texts((await searchPosts(ann, 'running park')).data)).toEqual([
        'I love running in the park',
      ]);
      expect(texts((await searchPosts(ann, 'PARK')).data)).toEqual([
        'The PARK is green',
        'I love running in the park',
      ]);
      // English-mode text indexes drop "the"; this index keeps every word.
      expect(texts((await searchPosts(ann, 'the park')).data)).toHaveLength(2);
      expect((await searchPosts(ann, 'nothing matches this')).data).toEqual([]);
    });

    it('shows private posts only to approved followers, and never deleted posts or reposts', async () => {
      const viewer = await world.user('viewer');
      const follower = await world.user('follower');
      const priv = await world.user('priv', { isPrivate: true });
      const pub = await world.user('pub');
      await as(follower).put(`/users/${priv.id}/follow`);
      const [request] = (await as(priv).get('/users/me/follow-requests')).body.data as {
        id: string;
      }[];
      await as(priv).post(`/users/me/follow-requests/${request?.id}/accept`);

      await world.post(priv, 'secret garden party');
      const publicId = await world.post(pub, 'public garden party');
      const goneId = await world.post(pub, 'deleted garden party');
      await as(pub).delete(`/posts/${goneId}`);
      await as(viewer).put(`/posts/${publicId}/repost`);

      expect(texts((await searchPosts(viewer, 'garden party')).data)).toEqual([
        'public garden party',
      ]);
      expect(texts((await searchPosts(follower, 'garden party')).data).sort()).toEqual([
        'public garden party',
        'secret garden party',
      ]);
    });

    it('paginates newest first without gaps or duplicates', async () => {
      const ann = await world.user('ann');
      for (let i = 0; i < 7; i += 1) await world.post(ann, `coffee number ${i}`);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const extra: string = cursor ? `&limit=3&cursor=${encodeURIComponent(cursor)}` : '&limit=3';
        const page = await searchPosts(ann, 'coffee', extra);
        seen.push(...texts(page.data));
        cursor = page.meta.nextCursor;
      } while (cursor);
      expect(seen).toEqual([6, 5, 4, 3, 2, 1, 0].map((i) => `coffee number ${i}`));
    });

    it('treats a lone #tag as a hashtag lookup, and neutralises $text operators', async () => {
      const ann = await world.user('ann');
      await world.post(ann, 'loving #TypeScript today');
      await world.post(ann, 'typescript without the tag');
      expect(texts((await searchPosts(ann, '#typescript')).data)).toEqual([
        'loving #TypeScript today',
      ]);

      // "-word" would negate and quotes would form phrases in raw $text syntax.
      expect(toTextSearch('-today "loving')).toBe('"today" "loving"');
      expect(toTextSearch('  ***  ')).toBeNull();
      expect((await searchPosts(ann, '"')).data).toEqual([]);
      expect((await as(ann).get('/search/posts?q=')).status).toBe(400);
    });
  });

  describe('hashtag pages', () => {
    it('lists a tag’s posts newest first, for #Tag or tag in any case', async () => {
      const ann = await world.user('ann');
      await world.post(ann, 'first #Vibe post');
      await world.post(ann, 'unrelated');
      await world.post(ann, 'second #vibe post');

      for (const tag of ['vibe', 'VIBE', '%23Vibe']) {
        const res = await as(ann).get(`/hashtags/${tag}/posts`);
        expect(res.status).toBe(200);
        expect(texts(res.body.data as PostDto[])).toEqual([
          'second #vibe post',
          'first #Vibe post',
        ]);
      }
      expect((await as(ann).get('/hashtags/not-a-tag!/posts')).status).toBe(400);
    });
  });

  describe('trending hashtags', () => {
    const trending = async (viewer: TestUser) =>
      (await as(viewer).get('/explore/trending')).body.data as TrendingHashtagDto[];

    it('ranks by distinct authors, so one account can’t make a tag trend', async () => {
      const [a, b, c, spammer] = [
        await world.user('aaa'),
        await world.user('bbb'),
        await world.user('ccc'),
        await world.user('spammer'),
      ];
      for (let i = 0; i < 6; i += 1) await world.post(spammer, `buy now #deal ${i}`);
      for (const user of [a, b, c]) await world.post(user, 'great match #worldcup');
      await world.post(a, 'also #deal');

      expect(await trending(a)).toEqual([
        { tag: 'worldcup', posts: 3, authors: 3 },
        { tag: 'deal', posts: 7, authors: 2 },
      ]);
    });

    it('leaves out private accounts’ tags and posts older than the window', async () => {
      const pub = await world.user('pub');
      const priv = await world.user('priv', { isPrivate: true });
      await world.post(priv, 'our plans #surpriseparty');
      const old = await world.post(pub, 'throwback #oldnews');
      // Raw collection write: Mongoose treats createdAt as immutable and would drop the change.
      await PostModel.collection.updateOne(
        { _id: new Types.ObjectId(old) },
        { $set: { createdAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) } },
      );
      await world.post(pub, 'today #fresh');

      expect((await trending(pub)).map((t) => t.tag)).toEqual(['fresh']);
    });

    it('is cached for everyone for a few minutes', async () => {
      const ann = await world.user('ann');
      await world.post(ann, 'first #one');
      expect((await trending(ann)).map((t) => t.tag)).toEqual(['one']);
      await world.post(ann, 'second #two');
      expect((await trending(ann)).map((t) => t.tag)).toEqual(['one']);
      await redis.del(CacheKeys.trendingHashtags());
      expect((await trending(ann)).map((t) => t.tag).sort()).toEqual(['one', 'two']);
    });
  });

  describe('who to follow', () => {
    const suggestions = async (viewer: TestUser) =>
      (await as(viewer).get('/explore/suggestions?limit=10')).body.data as SuggestedUserDto[];

    it('suggests friends of friends, most shared first, and filters live after a follow', async () => {
      const me = await world.user('myself');
      const [f1, f2] = [await world.user('friend1'), await world.user('friend2')];
      const [popular, niche] = [await world.user('popular'), await world.user('niche')];
      for (const friend of [f1, f2]) await as(me).put(`/users/${friend.id}/follow`);
      for (const friend of [f1, f2]) await as(friend).put(`/users/${popular.id}/follow`);
      await as(f1).put(`/users/${niche.id}/follow`);

      const first = await suggestions(me);
      expect(first.slice(0, 2).map((u) => [u.username, u.mutuals])).toEqual([
        ['popular', 2],
        ['niche', 1],
      ]);
      // Never yourself or people you already follow.
      expect(first.map((u) => u.username)).not.toContain('myself');
      expect(first.map((u) => u.username)).not.toContain('friend1');

      // Candidates are cached, but following someone removes them at once.
      await as(me).put(`/users/${popular.id}/follow`);
      expect((await suggestions(me)).map((u) => u.username)).not.toContain('popular');
    });

    it('falls back to popular accounts for newcomers, minus requests and blocks', async () => {
      const newbie = await world.user('newbie');
      const [star, priv, blocker] = [
        await world.user('star'),
        await world.user('priv', { isPrivate: true }),
        await world.user('blocker'),
      ];
      await UserModel.updateOne({ _id: star.id }, { $set: { 'counts.followers': 500 } });
      await UserModel.updateOne({ _id: priv.id }, { $set: { 'counts.followers': 400 } });
      await UserModel.updateOne({ _id: blocker.id }, { $set: { 'counts.followers': 300 } });
      await as(blocker).put(`/users/${newbie.id}/block`);

      const list = await suggestions(newbie);
      expect(list.slice(0, 2).map((u) => [u.username, u.mutuals, u.isPrivate])).toEqual([
        ['star', 0, false],
        ['priv', 0, true],
      ]);
      expect(list.map((u) => u.username)).not.toContain('blocker');

      await as(newbie).put(`/users/${priv.id}/follow`); // a pending request
      expect((await suggestions(newbie)).map((u) => u.username)).not.toContain('priv');
    });
  });

  describe('index use', () => {
    it('serves search, hashtag pages and suggestions from indexes', async () => {
      await Promise.all([PostModel.init(), UserModel.init()]);
      const plan = async (query: { explain: (v: string) => Promise<unknown> }) =>
        JSON.stringify(await query.explain('queryPlanner'));

      const text = await plan(
        PostModel.find({ $text: { $search: '"coffee"' }, deletedAt: null }).sort({ createdAt: -1 }),
      );
      expect(text).toContain('TEXT');
      const tag = await plan(
        PostModel.find({ hashtags: 'vibe', deletedAt: null }).sort({ createdAt: -1, _id: -1 }),
      );
      expect(tag).toContain('IXSCAN');
      expect(tag).not.toContain('"SORT"');
      const popular = await plan(
        UserModel.find({ deletedAt: null, username: { $type: 'string' } }).sort({
          'counts.followers': -1,
          _id: 1,
        }),
      );
      expect(popular).toContain('IXSCAN');
      expect(popular).not.toContain('COLLSCAN');
      const window = await plan(
        PostModel.find({ _id: { $gte: Types.ObjectId.createFromTime(0) } }),
      );
      expect(window).toContain('IXSCAN');
    });
  });
});
