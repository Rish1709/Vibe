/**
 * Measures the feed read path (database pull vs Redis timeline) as followings grow, plus timeline
 * rebuild and fan-out costs. Uses its own database (`vibe_bench`) and Redis logical DB 14, so dev data
 * is untouched; both are wiped at the start.
 *
 *   npm run bench:feed -w @vibe/api
 *
 * Numbers are machine-specific. They show how cost scales, not production capacity.
 */
import { performance } from 'node:perf_hooks';
import { Redis } from 'ioredis';
import mongoose, { Types } from 'mongoose';
import { pino } from 'pino';
import { z } from 'zod';
import { FeedConfig } from '../src/config/feed.js';
import { createFanoutProcessor } from '../src/modules/feed/fanout.processor.js';
import { createFeedService } from '../src/modules/feed/feed.service.js';
import { pullEntries } from '../src/modules/feed/pull.source.js';
import { createTimelineStore, type TimelineStore } from '../src/modules/feed/timeline.store.js';
import { PostModel } from '../src/modules/posts/post.model.js';
import { FollowModel } from '../src/modules/relationships/follow.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import type { AuthUser } from '../src/modules/users/user.service.js';

const env = z
  .object({
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),
    REDIS_URL: z.string().regex(/^rediss?:\/\//),
  })
  .parse(process.env);

const AUTHORS = 5_000;
const POSTS_PER_AUTHOR = 20;
const FOLLOWINGS = [10, 100, 1_000, 5_000];
const FANOUT_SIZES = [100, 1_000, 5_000];
const ITERATIONS = 100;
const PAGE = 20;

const silent = pino({ level: 'silent' });

function benchUri(uri: string): string {
  const url = new URL(uri);
  url.pathname = '/vibe_bench';
  return url.toString();
}

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

async function time(iterations: number, fn: () => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < 5; i++) await fn(); // warm-up: connection pools, plan cache, WiredTiger cache
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return samples;
}

const fmt = (ms: number) => `${ms.toFixed(1)} ms`;

/** A timeline store that always reports "rebuilding", forcing the feed service down the database path. */
function databaseOnly(store: TimelineStore): TimelineStore {
  return { ...store, state: () => Promise.resolve('rebuilding' as const) };
}

async function main() {
  await mongoose.connect(benchUri(env.MONGODB_URI));
  // Clear collections rather than dropping the database: on a replica set a dropped database can't be
  // recreated until the drop is majority-committed (DatabaseDropPending).
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  await Promise.all(Object.values(mongoose.models).map((model) => model.deleteMany({})));
  const redis = new Redis(env.REDIS_URL, { db: 14 });
  await redis.flushdb();

  console.log(`Seeding ${AUTHORS} authors x ${POSTS_PER_AUTHOR} posts...`);
  const now = Date.now();
  const authorIds = Array.from({ length: AUTHORS }, () => new Types.ObjectId());
  await UserModel.insertMany(
    authorIds.map((_id, i) => ({
      _id,
      clerkId: `bench_${i}`,
      username: `bench${i}`,
      displayName: `Bench ${i}`,
    })),
    { ordered: false },
  );
  for (let start = 0; start < AUTHORS; start += 500) {
    const posts = authorIds.slice(start, start + 500).flatMap((authorId) =>
      Array.from({ length: POSTS_PER_AUTHOR }, () => {
        const createdAt = new Date(now - Math.floor(Math.random() * 30 * 24 * 3600 * 1000));
        return { authorId, kind: 'original', text: 'bench', createdAt, updatedAt: createdAt };
      }),
    );
    await PostModel.insertMany(posts, { ordered: false });
  }

  const timeline = createTimelineStore(redis);
  const feed = createFeedService({ redis, logger: silent, timeline });
  const feedFromDb = createFeedService({ redis, logger: silent, timeline: databaseOnly(timeline) });

  const readRows: string[] = [];
  for (const following of FOLLOWINGS) {
    const viewerId = new Types.ObjectId();
    await UserModel.create({
      _id: viewerId,
      clerkId: `viewer_${following}`,
      username: `viewer${following}`,
      displayName: 'Viewer',
    });
    await FollowModel.insertMany(
      authorIds
        .slice(0, following)
        .map((followeeId) => ({ followerId: viewerId, followeeId, status: 'active' })),
    );
    const viewer: AuthUser = {
      id: viewerId.toHexString(),
      clerkId: `viewer_${following}`,
      username: `viewer${following}`,
      deleted: false,
    };
    const authors = [viewer.id, ...authorIds.slice(0, following).map((id) => id.toHexString())];

    // Rebuild cost: what a cold or invalidated timeline pays once.
    const rebuild = await time(10, async () => {
      await timeline.invalidate([viewer.id]);
      await feed.getFeed(viewer, { limit: PAGE });
    });

    const pull = await time(ITERATIONS, () => pullEntries(authors, null, PAGE + 1));
    const tl = await time(ITERATIONS, () => timeline.read(viewer.id, null, PAGE + 1));
    const fullDb = await time(ITERATIONS, () => feedFromDb.getFeed(viewer, { limit: PAGE }));
    const fullTl = await time(ITERATIONS, () => feed.getFeed(viewer, { limit: PAGE }));
    const check = await feed.getFeed(viewer, { limit: PAGE });
    if (check.source !== 'timeline' || check.items.length !== PAGE)
      throw new Error('Unexpected feed state');

    const [p, t, d, f, r] = [stats(pull), stats(tl), stats(fullDb), stats(fullTl), stats(rebuild)];
    readRows.push(
      `| ${following.toLocaleString()} | ${fmt(p.p50)} / ${fmt(p.p95)} | ${fmt(t.p50)} / ${fmt(t.p95)} | ` +
        `${fmt(d.p50)} / ${fmt(d.p95)} | ${fmt(f.p50)} / ${fmt(f.p95)} | ${fmt(r.p50)} |`,
    );
    console.log(`  following ${following}: done`);
  }

  // Fan-out cost: one post pushed to F followers who all have live timelines.
  const fanoutRows: string[] = [];
  const runFanout = createFanoutProcessor({ timeline, logger: silent });
  for (const followers of FANOUT_SIZES) {
    const authorId = new Types.ObjectId();
    const followerIds = Array.from({ length: followers }, () => new Types.ObjectId());
    await FollowModel.insertMany(
      followerIds.map((followerId) => ({ followerId, followeeId: authorId, status: 'active' })),
    );
    for (const id of followerIds) {
      const version = await timeline.beginRebuild(id.toHexString());
      if (version) await timeline.commitRebuild(id.toHexString(), version.version, []);
    }
    const samples = await time(10, () =>
      runFanout({
        data: {
          action: 'publish',
          postId: new Types.ObjectId().toHexString(),
          authorId: authorId.toHexString(),
          t: Date.now(),
        },
      } as never),
    );
    const s = stats(samples);
    fanoutRows.push(
      `| ${followers.toLocaleString()} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${((s.p50 / followers) * 1000).toFixed(1)} µs |`,
    );
    console.log(`  fan-out to ${followers}: done`);
  }

  console.log(
    `\nFeed read, first page of ${PAGE} (p50 / p95 over ${ITERATIONS} runs; ${AUTHORS * POSTS_PER_AUTHOR} posts total)\n`,
  );
  console.log(
    '| Following | DB pull (candidates) | Redis timeline (candidates) | Full page, DB path | Full page, timeline path | Rebuild (p50) |',
  );
  console.log('| --- | --- | --- | --- | --- | --- |');
  readRows.forEach((row) => console.log(row));
  console.log(`\nFan-out of one post (timeline cap ${FeedConfig.timelineMaxEntries})\n`);
  console.log('| Followers | p50 | p95 | Per follower (p50) |');
  console.log('| --- | --- | --- | --- |');
  fanoutRows.forEach((row) => console.log(row));

  await redis.flushdb();
  await redis.quit();
  await mongoose.connection.db?.dropDatabase();
  await mongoose.disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
