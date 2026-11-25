# Caching strategy

Redis holds caches and coordination state. **MongoDB is always the source of truth**: every Redis
structure can be deleted at any time and rebuilt, so a Redis outage degrades performance, never
correctness.

| What                         | Key                              | Type                   | TTL                       | Invalidation               | If Redis is down                |
| ---------------------------- | -------------------------------- | ---------------------- | ------------------------- | -------------------------- | ------------------------------- |
| Auth user (`clerkId → user`) | `v1:user:auth:{clerkId}`         | string (JSON)          | 5 min, jittered           | DEL on rename / delete     | read MongoDB                    |
| Home timeline                | `v1:feed:tl:{userId}`            | sorted set of post ids | 7 days, refreshed on read | DEL on follow-graph change | feed served from MongoDB        |
| Feed author list             | `v1:feed:authors:{userId}`       | string (JSON)          | 5 min                     | DEL with the timeline      | read MongoDB                    |
| Timeline version             | `v1:feed:ver:{userId}`           | counter                | 7 days                    | INCR on invalidation       | n/a                             |
| Rebuild lock                 | `v1:feed:lock:{userId}`          | string                 | 10 s                      | released after rebuild     | n/a                             |
| Rate limits                  | `rl:{policy}:{subject}`          | hash (2 windows)       | 2× window                 | expiry                     | limiter fails open              |
| Job queues                   | BullMQ keys under `QUEUE_PREFIX` | BullMQ                 | job retention             | n/a                        | feed updates logged and dropped |

Keys are versioned (`v1:`): a deploy that changes a cached shape bumps the version instead of reading
incompatible values. Cached JSON is re-validated with Zod on read; a malformed entry is a miss, not a crash.

## Home feed: fan-out on write vs on read

The feed is "posts by everyone I follow, newest first". There are two classic ways to build it.

|            | Fan-out on **read** (pull)                          | Fan-out on **write** (push)                             |
| ---------- | --------------------------------------------------- | ------------------------------------------------------- |
| On publish | 1 insert                                            | 1 insert + 1 timeline write per follower                |
| On read    | merge the latest posts of every followee            | read one precomputed list                               |
| Read cost  | grows with followings (one index seek per followee) | O(log n + page), flat                                   |
| Write cost | O(1)                                                | O(followers): a celebrity post means millions of writes |
| Memory     | none beyond the posts                               | a list per active user                                  |
| Freshness  | always current                                      | eventually consistent (fan-out lag)                     |
| Unfollow   | instant                                             | timeline must be repaired                               |

Neither is right on its own: pull makes reads expensive for people who follow many accounts, and push makes
writes explode for accounts with many followers. **Vibe uses the hybrid** (the approach large social
networks have described publicly):

1. **Ordinary authors are pushed.** On publish, a BullMQ job walks the author's followers in keyset-paged
   batches of 500 and `ZADD`s the post id into each follower's timeline, then trims it to 800 entries.
2. **Celebrity authors are pulled.** If the author has at least `FEED_CELEBRITY_THRESHOLD` (default 10,000)
   followers, the post is saved with `fanoutSkipped: true` and not pushed. At read time those posts are
   fetched from MongoDB through a **partial index containing only skipped posts**, and merged in.
3. **Read** = timeline page ∪ skipped posts from followees, merged by `(createdAt, _id)`, then hydrated.

### Why the decision is stored on the post

An earlier design re-derived "who is a celebrity" at read time from a cached author list. That breaks when
an author crosses the threshold: a viewer with a stale cache neither received the push nor pulled the post,
so it went missing. Going back below the threshold was worse, because posts made as a celebrity would stop
being pulled. Recording `fanoutSkipped` on the post makes the read side exact in both directions, and the
reader no longer needs to know anyone's follower count.

### Timelines are a cache of ids, not content

Only post ids are stored (about 64 bytes per entry, roughly 50 KB for a full 800-entry timeline). Hydration
loads current content and **re-checks visibility** (blocks, private accounts, deletion) on every read, so a
stale timeline can be incomplete but can never leak a post or show edited-away text. That is what makes the
simple invalidation strategy below safe.

### Lifecycle and invalidation

- **Lazy creation.** Fan-out only writes to timelines that already exist (checked inside a Lua script), so
  memory is spent only on people who are reading. Inactive users' timelines expire after 7 days and are
  rebuilt from MongoDB on their next visit.
- **Rebuild** = pull the newest 800 posts of `self ∪ followees` from MongoDB.
- **Follow-graph changes** (follow, unfollow, accept, remove follower, block) delete the affected users'
  timelines; the next read rebuilds them. Deleting is simpler and safer than patching (removing one
  author's posts from a sorted set would need a reverse index).
- **Deleted posts** disappear immediately (hydration); a background job removes their ids from timelines
  to free slots.
- **Read-your-writes.** The author's own timeline is updated synchronously on publish, so your post is at
  the top of your feed immediately even though followers get it asynchronously.
- **Beyond the cap.** Scrolling past the 800th entry continues seamlessly from MongoDB, because every
  source uses the same `(createdAt, _id)` cursor.

### Concurrency hazards handled

| Hazard                          | Without protection                                                                                  | Fix                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Post published during a rebuild | fan-out skips the (not yet existing) timeline; the rebuild's query predates the post, so it is lost | the rebuild creates the key first (a `~rebuilding` placeholder), so fan-out lands in it |
| Unfollow during a rebuild       | the rebuild writes back data computed before the unfollow                                           | per-user version counter; the commit (Lua) discards the result if the version changed   |
| Many first loads at once        | N concurrent rebuilds of the same timeline                                                          | `SET NX` lock; losers serve that page from MongoDB                                      |
| Rebuild crashes half-way        | a half-built key looks valid                                                                        | the placeholder means "not ready", and it has a 60 s TTL                                |
| Timeline becomes empty          | Redis deletes empty sorted sets, so fan-out (exists-only) skips the user forever                    | a permanent `~anchor` member keeps the key alive                                        |
| Same job enqueued twice         | double fan-out                                                                                      | deterministic BullMQ job id; ZADD is idempotent anyway                                  |

Each of these has a test, and each fix was mutation-checked (removing it makes its test fail).

### Failure modes

- **Redis down:** the whole feed is served from MongoDB (`X-Feed-Source: database`), with the same order and
  cursors. Tested against a Redis port with nothing listening.
- **Enqueue fails** (Redis down while publishing): the post is saved; followers whose timelines exist miss
  it until their timeline is next rebuilt. The upgrade path is a transactional outbox (write the event in
  the same MongoDB transaction as the post and relay it to the queue).
- **Worker down:** jobs wait in the queue and are processed when a worker returns; feeds lag but stay
  correct for anything already delivered.

### Consistency trade-offs, stated plainly

- Fan-out is asynchronous: followers see a new post after the job runs (milliseconds to seconds under load).
- A publish-delete race can briefly re-add a deleted id to a timeline; hydration filters it out.
- The author list is cached for up to 5 minutes but is invalidated on every follow-graph change, so the TTL
  is only a safety net.

## Rate limiting

See `apps/api/src/lib/rateLimiter.ts`: a sliding-window counter in a single Lua script (atomic, O(1) memory
per subject, uses Redis time so instances with skewed clocks agree). Fails open when Redis is down.

## Production notes

- **Separate Redis instances** for queues and caches. BullMQ requires `noeviction` (evicting a queue key
  loses jobs); caches should use `allkeys-lru` so memory pressure evicts cold timelines instead of failing
  writes. Locally one instance runs with `noeviction`.
- **Cluster mode:** every script touches a single key (or a key and its version counter, which would need a
  hash tag like `{userId}` to share a slot), and fan-out uses per-key pipelines rather than multi-key scripts.

## Feed benchmark

Measured with `npm run bench:feed -w @vibe/api` (100,000 posts by 5,000 authors; first page of 20;
p50 / p95 over 100 runs after warm-up). **Environment:** a Windows laptop running MongoDB 8 (single-node
replica set) and Redis 8 in Docker Desktop, Node 22, with other work running. These numbers show **how
cost scales**, not production capacity: absolute values on a real server will differ.

| Following | DB pull (candidates) | Redis timeline (candidates) | Full page, DB path | Full page, timeline path | Rebuild (p50) |
| --------- | -------------------- | --------------------------- | ------------------ | ------------------------ | ------------- |
| 10        | 4.9 / 9.3 ms         | 3.2 / 5.8 ms                | 29.5 / 63.5 ms     | 32.0 / 52.9 ms           | 93.9 ms       |
| 100       | 6.0 / 13.6 ms        | 2.9 / 3.5 ms                | 29.4 / 42.6 ms     | 31.8 / 46.2 ms           | 140.3 ms      |
| 1,000     | 64.8 / 89.9 ms       | 2.5 / 3.4 ms                | 133.7 / 171.8 ms   | 80.3 / 94.3 ms           | 332.3 ms      |
| 5,000     | 319.7 / 388.7 ms     | 1.7 / 2.6 ms                | 347.7 / 426.9 ms   | 53.0 / 79.0 ms           | 515.4 ms      |

| Fan-out of one post to | p50      | p95      | Per follower (p50) |
| ---------------------- | -------- | -------- | ------------------ |
| 100 followers          | 11.3 ms  | 12.7 ms  | 113 µs             |
| 1,000 followers        | 70.8 ms  | 121.1 ms | 71 µs              |
| 5,000 followers        | 165.0 ms | 509.3 ms | 33 µs              |

What the numbers say:

- **Candidate retrieval** is the part fan-out changes. Pulling from MongoDB grows roughly linearly with
  followings (one index seek per followee: 5 ms → 320 ms), while reading the Redis timeline stays flat at
  about 2–3 ms.
- **Full page** at small followings is about 30 ms either way: hydration (authors, relationships, likes,
  bookmarks) dominates. At 5,000 followings the timeline path is about 6.5× faster (53 ms vs 348 ms).
- **The timeline path is not yet flat end to end** (32 → 80 → 53 ms; the dip at 5,000 is within run-to-run
  noise on this machine). Two parts still scale with followings: the cached followee list (JSON of every
  followee id) and the celebrity pull, whose `$in` spans every followee even when few have skipped posts.
  The next optimization is to track which followees have ever published a `fanoutSkipped` post (rare by
  definition) and pull only those.
- **Rebuild** is the price of a cold or invalidated timeline: 0.1–0.5 s, paid once, then amortized over every
  page load until the next follow-graph change.
- **Fan-out** costs tens of microseconds per follower, batched 500 per pipeline, off the request path. At
  that rate a 10,000-follower author (the default celebrity threshold) costs roughly 0.3–1 s of worker time
  per post, which is why authors above it are pulled instead.
