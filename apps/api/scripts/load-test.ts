/**
 * HTTP load test of the *production build* (`dist/server.js`, NODE_ENV=production) against real
 * MongoDB and Redis, with a realistic mix of signed-in traffic.
 *
 *   npm run build -w @vibe/shared && npm run build -w @vibe/api
 *   npm run load-test -w @vibe/api
 *
 * How it stays honest and isolated:
 * - The server is the real entry point in its own process; this script only generates load.
 * - Sign-in uses Clerk's networkless mode (a PEM public key, `CLERK_JWT_KEY`), which is a supported
 *   production configuration: every request still verifies an RS256 signature, expiry and `azp`.
 *   The key pair is generated here, so no Clerk account or network is involved.
 * - Its own database (`vibe_load`), Redis logical DB 13 and queue prefix: dev data is untouched.
 * - The per-user rate limit stays at its production value. The per-IP limit is raised, because every
 *   virtual user shares this machine's IP.
 *
 * Numbers are for this machine, with load generator, server, MongoDB and Redis sharing its CPU. They
 * show where latency bends as concurrency grows, not production capacity.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { Redis } from 'ioredis';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { PostModel } from '../src/modules/posts/post.model.js';
import { FollowModel } from '../src/modules/relationships/follow.model.js';
import { UserModel } from '../src/modules/users/user.model.js';

const env = z
  .object({
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),
    REDIS_URL: z.string().regex(/^rediss?:\/\//),
  })
  .parse(process.env);

const USERS = 2_000;
const FOLLOWS_PER_USER = 50;
const POSTS_PER_USER = 20;
const TAGS = Array.from({ length: 30 }, (_, i) => `topic${i}`);
const CONCURRENCY = [8, 32, 128];
const WARMUP_MS = 5_000;
const STEP_MS = 20_000;
const PORT = 4100;
const ORIGIN = 'http://load.test';
const SERVER_ENTRY = 'dist/server.js';

const withPath = (uri: string, path: string) => {
  const url = new URL(uri);
  url.pathname = path;
  return url.toString();
};
const MONGO_URI = withPath(env.MONGODB_URI, '/vibe_load');
const REDIS_URI = withPath(env.REDIS_URL, '/13');

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

// ---------------------------------------------------------------------------------------------
// Data

interface World {
  users: { id: string; clerkId: string; username: string }[];
  postIds: string[];
}

async function seed(): Promise<World> {
  await mongoose.connect(MONGO_URI);
  await mongoose.connection.dropDatabase();
  await Promise.all([UserModel.init(), PostModel.init(), FollowModel.init()]);

  const users = Array.from({ length: USERS }, (_, i) => ({
    _id: new Types.ObjectId(),
    clerkId: `user_load_${i}`,
    username: `load${i}`,
    displayName: `Load User ${i}`,
    searchTokens: [`load${i}`, 'load', 'user'],
  }));
  const follows: { followerId: Types.ObjectId; followeeId: Types.ObjectId; status: string }[] = [];
  const followers = new Map<string, number>();
  for (const user of users) {
    const followees = new Set<Types.ObjectId>();
    while (followees.size < FOLLOWS_PER_USER) {
      const other = pick(users);
      if (other._id !== user._id) followees.add(other._id);
    }
    for (const followeeId of followees) {
      follows.push({ followerId: user._id, followeeId, status: 'active' });
      followers.set(followeeId.toHexString(), (followers.get(followeeId.toHexString()) ?? 0) + 1);
    }
  }
  await UserModel.insertMany(
    users.map((user) => ({
      ...user,
      counts: {
        followers: followers.get(user._id.toHexString()) ?? 0,
        following: FOLLOWS_PER_USER,
        posts: POSTS_PER_USER,
      },
    })),
    { ordered: false },
  );
  await FollowModel.insertMany(follows, { ordered: false });

  const now = Date.now();
  const postIds: string[] = [];
  for (let start = 0; start < USERS; start += 200) {
    const posts = users.slice(start, start + 200).flatMap((user) =>
      Array.from({ length: POSTS_PER_USER }, () => {
        const tag = pick(TAGS);
        const createdAt = new Date(now - Math.floor(Math.random() * 6 * 24 * 3600 * 1000));
        // The id's timestamp must match createdAt (trending finds its window by _id range), and the
        // rest must be unique: createFromTime alone zero-fills it, so same-second ids would collide.
        const seconds = Math.floor(createdAt.getTime() / 1000)
          .toString(16)
          .padStart(8, '0');
        const _id = new Types.ObjectId(seconds + randomBytes(8).toString('hex'));
        postIds.push(_id.toHexString());
        return {
          _id,
          authorId: user._id,
          kind: 'original',
          text: `load test post about #${tag}`,
          hashtags: [tag],
          createdAt,
          updatedAt: createdAt,
        };
      }),
    );
    await PostModel.insertMany(posts, { ordered: false });
  }
  await mongoose.disconnect();
  return {
    users: users.map((u) => ({
      id: u._id.toHexString(),
      clerkId: u.clerkId,
      username: u.username,
    })),
    postIds,
  };
}

// ---------------------------------------------------------------------------------------------
// Server

async function startServer(jwtKey: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--enable-source-maps', SERVER_ENTRY], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      PORT: String(PORT),
      MONGODB_URI: MONGO_URI,
      REDIS_URL: REDIS_URI,
      QUEUE_PREFIX: 'vibe-load',
      CORS_ORIGINS: ORIGIN,
      CLERK_SECRET_KEY: 'sk_test_load_test_unused',
      CLERK_JWT_KEY: jwtKey,
      RATE_LIMIT_ANONYMOUS_PER_MINUTE: '100000000',
    },
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health/ready`);
      if (res.ok) return child;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  child.kill();
  throw new Error('Server did not become ready within 30s');
}

// ---------------------------------------------------------------------------------------------
// Load

type Scenario = { name: string; weight: number; run: (token: string, world: World) => Request };

const get = (path: string, token: string) =>
  new Request(`http://127.0.0.1:${PORT}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

const SCENARIOS: Scenario[] = [
  { name: 'GET /feed', weight: 40, run: (t) => get('/feed', t) },
  {
    name: 'GET /users/:username',
    weight: 10,
    run: (t, w) => get(`/users/${pick(w.users).username}`, t),
  },
  {
    name: 'GET /users/:id/posts',
    weight: 15,
    run: (t, w) => get(`/users/${pick(w.users).id}/posts`, t),
  },
  { name: 'GET /posts/:id', weight: 10, run: (t, w) => get(`/posts/${pick(w.postIds)}`, t) },
  { name: 'GET /explore/trending', weight: 5, run: (t) => get('/explore/trending', t) },
  {
    name: 'GET /hashtags/:tag/posts',
    weight: 5,
    run: (t) => get(`/hashtags/${pick(TAGS)}/posts`, t),
  },
  {
    name: 'PUT|DELETE /posts/:id/like',
    weight: 15,
    run: (t, w) =>
      new Request(`http://127.0.0.1:${PORT}/api/v1/posts/${pick(w.postIds)}/like`, {
        method: Math.random() < 0.5 ? 'PUT' : 'DELETE',
        headers: { Authorization: `Bearer ${t}` },
      }),
  },
];
const TOTAL_WEIGHT = SCENARIOS.reduce((sum, s) => sum + s.weight, 0);
function chooseScenario(): Scenario {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const scenario of SCENARIOS) {
    roll -= scenario.weight;
    if (roll < 0) return scenario;
  }
  return SCENARIOS[0]!;
}

interface Sample {
  scenario: string;
  ms: number;
  status: number;
}

/** Closed loop: `concurrency` virtual users, each sending its next request when the last returns. */
async function runStep(concurrency: number, durationMs: number, world: World, tokens: string[]) {
  const samples: Sample[] = [];
  const end = performance.now() + durationMs;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < end) {
        const scenario = chooseScenario();
        const request = scenario.run(pick(tokens), world);
        const start = performance.now();
        let status: number;
        try {
          const res = await fetch(request);
          await res.arrayBuffer();
          status = res.status;
        } catch {
          status = 0;
        }
        samples.push({ scenario: scenario.name, ms: performance.now() - start, status });
      }
    }),
  );
  return samples;
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const fmt = (ms: number) => ms.toFixed(1).padStart(7);

function report(concurrency: number, samples: Sample[], durationMs: number) {
  const ok = samples.filter((s) => s.status >= 200 && s.status < 300);
  const errors = new Map<number, number>();
  for (const s of samples)
    if (s.status < 200 || s.status >= 300) errors.set(s.status, (errors.get(s.status) ?? 0) + 1);
  const all = ok.map((s) => s.ms).sort((a, b) => a - b);
  console.log(
    `\n## ${concurrency} concurrent users: ${(samples.length / (durationMs / 1000)).toFixed(0)} req/s, ` +
      `p50 ${fmt(percentile(all, 50)).trim()} ms, p95 ${fmt(percentile(all, 95)).trim()} ms, ` +
      `p99 ${fmt(percentile(all, 99)).trim()} ms, errors ${errors.size === 0 ? 'none' : JSON.stringify(Object.fromEntries(errors))}`,
  );
  console.log(
    `| Endpoint | Requests | p50 ms | p95 ms | p99 ms |\n| --- | ---: | ---: | ---: | ---: |`,
  );
  for (const scenario of SCENARIOS) {
    const times = ok
      .filter((s) => s.scenario === scenario.name)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    console.log(
      `| ${scenario.name} | ${times.length} | ${fmt(percentile(times, 50))} | ${fmt(percentile(times, 95))} | ${fmt(percentile(times, 99))} |`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Round trips per request: independent of hardware, and multiplied by whatever the network latency is.

const ROUND_TRIP_SAMPLES = 100;

/**
 * Counts what the server sends to each database, scoped to the load-test databases (so other apps on
 * the same MongoDB and Redis don't add noise):
 * - MongoDB: operations recorded by the profiler on `vibe_load`.
 * - Redis: commands from clients on logical DB 13, seen through MONITOR. Commands that run inside a Lua
 *   script are excluded (the script is one round trip); pipelined commands count individually.
 */
async function measureRoundTrips(world: World, tokens: string[]) {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db!;
  // A bigger profile collection than the 1 MB default, so a pass can't wrap around.
  await db.command({ profile: 0 });
  await db
    .collection('system.profile')
    .drop()
    .catch(() => undefined);
  await db.createCollection('system.profile', { capped: true, size: 64 * 2 ** 20 });
  const profiled = () =>
    db.collection('system.profile').countDocuments({ ns: { $regex: /^vibe_load\.(?!system\.)/ } });

  const monitorClient = new Redis(REDIS_URI);
  const monitor = await monitorClient.monitor();
  let redisCommands = 0;
  monitor.on('monitor', (_time: string, _args: string[], source: string, database: string) => {
    if (database === '13' && source !== 'lua') redisCommands++;
  });

  console.log(
    `\n## Database round trips per request (${ROUND_TRIP_SAMPLES} sequential requests each)`,
  );
  console.log('| Endpoint | MongoDB operations | Redis commands |\n| --- | ---: | ---: |');
  // The same distinct users for every row, so the second feed pass reads timelines the first built.
  const sample = [...tokens].sort(() => Math.random() - 0.5).slice(0, ROUND_TRIP_SAMPLES);
  const passes = [
    ...SCENARIOS.map((scenario) => ({ label: scenario.name, scenario })),
    { label: 'GET /feed (again: cached timelines)', scenario: SCENARIOS[0]! },
  ];
  await db.command({ profile: 2 });
  try {
    for (const { label, scenario } of passes) {
      const mongoBefore = await profiled();
      redisCommands = 0;
      for (const token of sample) {
        const res = await fetch(scenario.run(token, world));
        await res.arrayBuffer();
      }
      await new Promise((resolve) => setTimeout(resolve, 200)); // let MONITOR lines arrive
      const mongo = (await profiled()) - mongoBefore;
      console.log(
        `| ${label} | ${(mongo / sample.length).toFixed(1)} | ${(redisCommands / sample.length).toFixed(1)} |`,
      );
    }
  } finally {
    await db.command({ profile: 0 });
    monitor.disconnect();
    monitorClient.disconnect();
    await mongoose.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `${SERVER_ENTRY} not found: run "npm run build -w @vibe/shared && npm run build -w @vibe/api" first`,
    );
  }
  const redis = new Redis(REDIS_URI);
  await redis.flushdb();

  console.log(
    `Seeding ${USERS} users, ${USERS * FOLLOWS_PER_USER} follows, ${USERS * POSTS_PER_USER} posts...`,
  );
  const world = await seed();

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const now = Math.floor(Date.now() / 1000);
  const tokens = await Promise.all(
    world.users.map((user) =>
      new SignJWT({ sid: `sess_${user.clerkId}`, azp: ORIGIN, v: 2 })
        .setProtectedHeader({ alg: 'RS256', kid: 'ins_load' })
        .setSubject(user.clerkId)
        .setIssuedAt(now - 1)
        .setNotBefore(now - 1)
        .setExpirationTime(now + 30 * 60)
        .sign(privateKey),
    ),
  );

  const server = await startServer(await exportSPKI(publicKey));
  try {
    console.log(
      `\n# Load test: production build, ${os.cpus().length} logical CPUs (${os.cpus()[0]?.model.trim()}), ` +
        `${Math.round(os.totalmem() / 2 ** 30)} GB RAM, Node ${process.version}`,
    );
    console.log(`Warming up for ${WARMUP_MS / 1000}s (connection pools, caches, JIT)...`);
    await runStep(8, WARMUP_MS, world, tokens);
    if (process.argv.includes('--round-trips-only')) {
      await measureRoundTrips(world, tokens);
      return;
    }
    await measureRoundTrips(world, tokens);
    for (const concurrency of CONCURRENCY) {
      const samples = await runStep(concurrency, STEP_MS, world, tokens);
      report(concurrency, samples, STEP_MS);
    }
  } finally {
    server.kill('SIGTERM');
    await redis.flushdb();
    await redis.quit();
    await mongoose.connect(MONGO_URI);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
