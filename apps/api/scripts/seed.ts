/**
 * Seeds realistic development data: users, a follow graph, posts with hashtags, reposts, quotes,
 * likes, comments and bookmarks, with every denormalized counter computed to match.
 *
 *   npm run seed -w @vibe/api                   # 40 users
 *   npm run seed -w @vibe/api -- --users 200
 *   npm run seed -w @vibe/api -- --connect rizzhub   # also wire your real account into the graph
 *
 * Safe to re-run: it deletes only data belonging to seed accounts (clerkId "seed_*"), which can never
 * collide with real Clerk ids ("user_*"). Refuses to run with NODE_ENV=production.
 * Seed accounts cannot sign in; they exist to be followed, liked and commented on.
 */
import { faker } from '@faker-js/faker';
import mongoose, { Types } from 'mongoose';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { CommentModel } from '../src/modules/comments/comment.model.js';
import { BookmarkModel, LikeModel } from '../src/modules/engagement/engagement.models.js';
import { extractHashtags } from '../src/modules/posts/hashtags.js';
import { PostModel } from '../src/modules/posts/post.model.js';
import { BlockModel } from '../src/modules/relationships/block.model.js';
import { FollowModel } from '../src/modules/relationships/follow.model.js';
import { UserModel } from '../src/modules/users/user.model.js';
import { searchTokensFor } from '../src/modules/users/user.search.js';

const env = z
  .object({
    NODE_ENV: z.string().default('development'),
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),
  })
  .parse(process.env);

if (env.NODE_ENV === 'production') {
  throw new Error('Refusing to seed a production database');
}

const { values: args } = parseArgs({
  options: {
    users: { type: 'string', default: '40' },
    connect: { type: 'string' },
  },
});
const USER_COUNT = z.coerce.number().int().min(5).max(5000).parse(args.users);

const SEED_PREFIX = 'seed_';
const TOPICS = [
  'coffee',
  'travel',
  'buildinpublic',
  'design',
  'running',
  'music',
  'books',
  'photography',
  'startups',
  'cooking',
  'ai',
  'webdev',
];
const DAY = 24 * 3600 * 1000;

faker.seed(1709); // Deterministic: the same command produces the same world.

const oid = () => new Types.ObjectId();
const pick = <T>(items: readonly T[]): T => faker.helpers.arrayElement(items);
const sample = <T>(items: readonly T[], n: number): T[] =>
  faker.helpers.arrayElements(items, Math.min(n, items.length));
const recent = (maxDaysAgo: number) =>
  new Date(Date.now() - faker.number.float() * maxDaysAgo * DAY);
const later = (after: Date) =>
  new Date(Math.min(Date.now(), after.getTime() + faker.number.float() * 3 * DAY));

function uniqueUsername(taken: Set<string>): string {
  for (;;) {
    const base = faker.internet
      .username()
      .toLowerCase()
      .replace(/[^a-z0-9_.]/g, '')
      .replace(/\.{2,}/g, '.')
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 24);
    const name = base.length >= 3 ? base : `${base}user`;
    const candidate = taken.has(name) ? `${name}${faker.number.int({ min: 10, max: 999 })}` : name;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

function postText(): string {
  const tags = sample(TOPICS, faker.number.int({ min: 0, max: 2 })).map((t) => `#${t}`);
  return [faker.lorem.sentences({ min: 1, max: 3 }), ...tags].join(' ').slice(0, 500);
}

/** Sets follower/following counters from the edges themselves (the source of truth). */
async function recomputeFollowCounts(ids: Types.ObjectId[]) {
  const unique = new Map(ids.map((id) => [id.toHexString(), id]));
  for (const id of unique.values()) {
    const [followers, following] = await Promise.all([
      FollowModel.countDocuments({ followeeId: id, status: 'active' }),
      FollowModel.countDocuments({ followerId: id, status: 'active' }),
    ]);
    await UserModel.updateOne(
      { _id: id },
      { $set: { 'counts.followers': followers, 'counts.following': following } },
    );
  }
}

/** Deletes previous seed data; returns the real accounts whose follow edges with seeds were removed. */
async function removePreviousSeed(): Promise<Types.ObjectId[]> {
  const seedUsers = await UserModel.find(
    { clerkId: { $regex: `^${SEED_PREFIX}` } },
    { _id: 1 },
  ).lean();
  const ids = seedUsers.map((u) => u._id);
  if (ids.length === 0) return [];
  const seedIds = new Set(ids.map((id) => id.toHexString()));
  const edges = await FollowModel.find(
    { $or: [{ followerId: { $in: ids } }, { followeeId: { $in: ids } }] },
    { followerId: 1, followeeId: 1 },
  ).lean();
  const realUsersTouched = edges
    .flatMap((edge) => [edge.followerId, edge.followeeId])
    .filter((id) => !seedIds.has(id.toHexString()));
  const seedPosts = await PostModel.find({ authorId: { $in: ids } }, { _id: 1 }).lean();
  const postIds = seedPosts.map((p) => p._id);
  await Promise.all([
    FollowModel.deleteMany({ $or: [{ followerId: { $in: ids } }, { followeeId: { $in: ids } }] }),
    BlockModel.deleteMany({ $or: [{ blockerId: { $in: ids } }, { blockedId: { $in: ids } }] }),
    LikeModel.deleteMany({ $or: [{ userId: { $in: ids } }, { postId: { $in: postIds } }] }),
    BookmarkModel.deleteMany({ $or: [{ userId: { $in: ids } }, { postId: { $in: postIds } }] }),
    CommentModel.deleteMany({ $or: [{ authorId: { $in: ids } }, { postId: { $in: postIds } }] }),
    PostModel.deleteMany({ $or: [{ authorId: { $in: ids } }, { sharedPostId: { $in: postIds } }] }),
  ]);
  await UserModel.deleteMany({ _id: { $in: ids } });
  console.log(`Removed previous seed data (${ids.length} users, ${postIds.length} posts)`);
  return realUsersTouched;
}

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  const realUsersTouched = await removePreviousSeed();

  const existing = new Set(
    (await UserModel.find({ username: { $type: 'string' } }, { username: 1 }).lean()).flatMap(
      (u) => (u.username ? [u.username] : []),
    ),
  );

  // --- users -------------------------------------------------------------------------------------
  const users = Array.from({ length: USER_COUNT }, (_, i) => {
    const first = faker.person.firstName();
    const last = faker.person.lastName();
    return {
      _id: oid(),
      clerkId: `${SEED_PREFIX}${i}`,
      email: null,
      username: uniqueUsername(existing),
      displayName: `${first} ${last}`,
      searchTokens: searchTokensFor(`${first} ${last}`),
      bio: faker.number.float() < 0.8 ? faker.person.bio().slice(0, 160) : '',
      website: faker.number.float() < 0.3 ? faker.internet.url() : null,
      avatarUrl: `https://i.pravatar.cc/240?u=${i}`,
      isPrivate: faker.number.float() < 0.1,
      messagePolicy: 'everyone' as const,
      counts: { followers: 0, following: 0, posts: 0 },
      createdAt: recent(120),
    };
  });
  const byId = new Map(users.map((u) => [u._id.toHexString(), u]));

  // --- follow graph: a few popular accounts, a long tail (roughly power-law) ---------------------
  const popular = sample(users, Math.max(2, Math.floor(USER_COUNT * 0.1)));
  const follows: {
    _id: Types.ObjectId;
    followerId: Types.ObjectId;
    followeeId: Types.ObjectId;
    status: 'active' | 'pending';
    createdAt: Date;
  }[] = [];
  const edge = new Set<string>();
  const addFollow = (
    follower: (typeof users)[number] | { _id: Types.ObjectId },
    followee: (typeof users)[number] | { _id: Types.ObjectId; isPrivate: boolean },
  ) => {
    const key = `${follower._id.toHexString()}>${followee._id.toHexString()}`;
    if (follower._id.equals(followee._id) || edge.has(key)) return;
    edge.add(key);
    const status = followee.isPrivate && faker.number.float() < 0.3 ? 'pending' : 'active';
    follows.push({
      _id: oid(),
      followerId: follower._id,
      followeeId: followee._id,
      status,
      createdAt: recent(60),
    });
  };
  for (const user of users) {
    for (const target of sample(popular, faker.number.int({ min: 1, max: popular.length })))
      addFollow(user, target);
    for (const target of sample(users, faker.number.int({ min: 3, max: 12 })))
      addFollow(user, target);
  }

  // --- posts, reposts and quotes -----------------------------------------------------------------
  type SeedPost = {
    _id: Types.ObjectId;
    authorId: Types.ObjectId;
    kind: 'original' | 'repost' | 'quote';
    text: string;
    hashtags: string[];
    sharedPostId: Types.ObjectId | null;
    counts: { likes: number; comments: number; reposts: number };
    createdAt: Date;
    updatedAt: Date;
  };
  const posts: SeedPost[] = [];
  for (const user of users) {
    const n = popular.includes(user)
      ? faker.number.int({ min: 6, max: 12 })
      : faker.number.int({ min: 1, max: 6 });
    for (let i = 0; i < n; i++) {
      const text = postText();
      const createdAt = recent(30);
      posts.push({
        _id: oid(),
        authorId: user._id,
        kind: 'original',
        text,
        hashtags: extractHashtags(text),
        sharedPostId: null,
        counts: { likes: 0, comments: 0, reposts: 0 },
        createdAt,
        updatedAt: createdAt,
      });
    }
  }
  const publicOriginals = posts.filter((p) => !byId.get(p.authorId.toHexString())?.isPrivate);
  const reshared = new Set<string>();
  for (const user of sample(users, Math.floor(USER_COUNT * 0.6))) {
    for (const target of sample(publicOriginals, faker.number.int({ min: 1, max: 3 }))) {
      if (target.authorId.equals(user._id)) continue;
      const key = `${user._id.toHexString()}:${target._id.toHexString()}`;
      const isQuote = faker.number.float() < 0.35;
      if (!isQuote && reshared.has(key)) continue; // one plain repost per user per post
      reshared.add(key);
      const text = isQuote ? faker.lorem.sentence() : '';
      const createdAt = later(target.createdAt);
      posts.push({
        _id: oid(),
        authorId: user._id,
        kind: isQuote ? 'quote' : 'repost',
        text,
        hashtags: extractHashtags(text),
        sharedPostId: target._id,
        counts: { likes: 0, comments: 0, reposts: 0 },
        createdAt,
        updatedAt: createdAt,
      });
      target.counts.reposts += 1;
    }
  }
  const engageable = posts.filter((p) => p.kind !== 'repost');

  // --- likes, comments, bookmarks ------------------------------------------------------------------
  const likes: { postId: Types.ObjectId; userId: Types.ObjectId; createdAt: Date }[] = [];
  const bookmarks: { postId: Types.ObjectId; userId: Types.ObjectId; createdAt: Date }[] = [];
  const comments: {
    _id: Types.ObjectId;
    postId: Types.ObjectId;
    authorId: Types.ObjectId;
    parentId: Types.ObjectId | null;
    text: string;
    counts: { replies: number };
    createdAt: Date;
    updatedAt: Date;
  }[] = [];
  for (const post of engageable) {
    const author = byId.get(post.authorId.toHexString());
    const audience = users.filter(
      (u) =>
        !u._id.equals(post.authorId) &&
        !(author?.isPrivate && !edge.has(`${u._id.toHexString()}>${post.authorId.toHexString()}`)),
    );
    for (const fan of sample(
      audience,
      faker.number.int({ min: 0, max: Math.min(25, audience.length) }),
    )) {
      likes.push({ postId: post._id, userId: fan._id, createdAt: later(post.createdAt) });
      post.counts.likes += 1;
      if (faker.number.float() < 0.08)
        bookmarks.push({ postId: post._id, userId: fan._id, createdAt: later(post.createdAt) });
    }
    for (const commenter of sample(audience, faker.number.int({ min: 0, max: 4 }))) {
      const createdAt = later(post.createdAt);
      const top = {
        _id: oid(),
        postId: post._id,
        authorId: commenter._id,
        parentId: null,
        text: faker.lorem.sentence().slice(0, 300),
        counts: { replies: 0 },
        createdAt,
        updatedAt: createdAt,
      };
      comments.push(top);
      post.counts.comments += 1;
      if (faker.number.float() < 0.4) {
        const replier = faker.number.float() < 0.5 ? { _id: post.authorId } : pick(audience);
        const replyAt = later(createdAt);
        comments.push({
          _id: oid(),
          postId: post._id,
          authorId: replier._id,
          parentId: top._id,
          text: faker.lorem.sentence().slice(0, 300),
          counts: { replies: 0 },
          createdAt: replyAt,
          updatedAt: replyAt,
        });
        top.counts.replies += 1;
        post.counts.comments += 1;
      }
    }
  }

  // --- optionally connect a real account -----------------------------------------------------------
  let connectedId: Types.ObjectId | null = null;
  if (args.connect) {
    const me = await UserModel.findOne({
      username: args.connect.toLowerCase(),
      deletedAt: null,
    }).lean();
    if (!me) throw new Error(`No onboarded user "${args.connect}" to connect`);
    connectedId = me._id;
    for (const target of sample(
      users.filter((u) => !u.isPrivate),
      12,
    ))
      addFollow(me, target);
    for (const fan of sample(users, 8)) addFollow(fan, me);
    console.log(`Connected @${me.username}: follows 12 seed accounts, followed by 8`);
  }

  // --- counters derived from the edges, so they are exactly consistent ----------------------------
  const active = follows.filter((f) => f.status === 'active');
  for (const f of active) {
    const follower = byId.get(f.followerId.toHexString());
    const followee = byId.get(f.followeeId.toHexString());
    if (follower) follower.counts.following += 1;
    if (followee) followee.counts.followers += 1;
  }
  for (const post of posts) {
    const author = byId.get(post.authorId.toHexString());
    if (author && post.kind !== 'repost') author.counts.posts += 1;
  }

  await UserModel.insertMany(users, { ordered: false });
  await FollowModel.insertMany(follows, { ordered: false });
  await PostModel.insertMany(posts, { ordered: false });
  await LikeModel.insertMany(likes, { ordered: false });
  await BookmarkModel.insertMany(bookmarks, { ordered: false });
  await CommentModel.insertMany(comments, { ordered: false });
  // Real accounts' counters are recomputed from the edges rather than incremented, so re-running
  // the seed (which deletes and recreates their edges with seed users) can never make them drift.
  await recomputeFollowCounts([...realUsersTouched, ...(connectedId ? [connectedId] : [])]);

  console.log(
    `Seeded ${users.length} users, ${follows.length} follows (${follows.length - active.length} pending), ` +
      `${posts.length} posts, ${likes.length} likes, ${comments.length} comments, ${bookmarks.length} bookmarks`,
  );
  await mongoose.disconnect();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await mongoose.disconnect();
  process.exit(1);
});
