# Scalability

What limits Vibe as it grows, what was measured, and what changes at each order of magnitude. The
principle throughout: **cost per request should depend on the size of the answer, not the size of the
data**, and anything that can't meet that is cached, precomputed or moved off the request path.

## What already scales

| Concern          | How                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------- |
| API instances    | Stateless (JWT auth, no sessions), so add instances behind the load balancer              |
| Realtime         | Socket.IO Redis adapter: an event reaches a user on whichever instance holds their socket |
| Background work  | BullMQ: add workers; each job goes to one of them; schedules are declared idempotently    |
| Lists            | Keyset pagination on an index: O(log n + page) at any depth                               |
| Query plans      | A test fails on any collection scan or in-memory sort (outside listed exceptions)         |
| Feed reads       | A Redis sorted set per user: one `ZREVRANGE` plus a batched hydration                     |
| Celebrity writes | Not fanned out (would be millions of writes); merged in at read time instead              |
| Hot reads        | Cached with jittered TTLs: auth lookups, trending, suggestions                            |
| Uploads          | Never pass through the API: the browser uploads straight to the CDN                       |
| Abuse            | Per-IP and per-user sliding-window rate limits, shared across instances via Redis         |

## Measured

`npm run load-test -w @vibe/api` drives the **compiled production server** against real MongoDB and
Redis: 2,000 users, 100,000 follows, 40,000 posts, real RS256 token verification, and a mix of feeds,
profiles, posts, hashtags, trending and likes.

**Round trips per request** don't depend on hardware, and each one costs a network round trip, so this
is the number to keep small (measured exactly: the profiler for MongoDB, MONITOR for Redis):

| Endpoint                                      | MongoDB operations | Redis commands |
| --------------------------------------------- | -----------------: | -------------: |
| `GET /feed` (first read: builds the timeline) |                 13 |             23 |
| `GET /feed` (timeline cached)                 |                  9 |             13 |
| `GET /users/:username`                        |                  4 |              3 |
| `GET /users/:id/posts`                        |                  8 |              3 |
| `GET /posts/:id`                              |                  8 |              3 |
| `GET /hashtags/:tag/posts`                    |                  8 |              3 |
| `PUT/DELETE /posts/:id/like`                  |                6.5 |            4.5 |
| `GET /explore/trending`                       |                  0 |              4 |

Every request spends 3 Redis commands on the IP rate limit, the sign-in cache and the per-user rate limit.
Lists cost the same at any page size (batch hydration; a test enforces it). This measurement found posts
and profile pages re-reading what their access check had already loaded: 12 queries became 8.

**Throughput on the development laptop** (i5-1335U on battery, MongoDB and Redis in Docker Desktop on
Windows): about 25 requests per second at every concurrency from 8 to 128, with no errors, and latency
rising with concurrency (p50 260 ms at 8 users, 6.4 s at 128). Flat throughput with rising latency
means a shared bottleneck, and it was isolated: MongoDB in Docker Desktop on Windows answered at most
about 1,400 simple queries per second even from inside Docker's own network, and 4 ms per round trip
from the host, against tens of thousands per second for a native MongoDB. At roughly 8 to 13 queries per
request that cap is the ceiling observed. These latencies describe this machine, not the application; the
round-trip counts above are what carry over.

## Bottlenecks in order of arrival

1. **The feed fan-out worker.** Each post costs one Redis write per follower. A user with 5,000 followers
   costs 5,000 `ZADD`s (pipelined). The celebrity threshold caps the worst case; beyond that, add workers.
   The measured costs are in [caching-strategy.md](caching-strategy.md#feed-benchmark).
2. **Redis memory.** Timelines are capped (most recent entries only) and expire after 7 days of inactivity,
   so memory tracks _active_ users. Next: separate Redis instances for queues (`noeviction`, required by
   BullMQ) and caches (`allkeys-lru`, so pressure evicts cold timelines), then Redis Cluster; every key
   that must be updated atomically with another shares a hash tag.
3. **MongoDB reads.** Lists are index range scans, so the next lever is read replicas for read-heavy,
   staleness-tolerant queries (profiles, followers, hashtag pages), keeping writes and read-your-own-write
   paths on the primary.
4. **Post search.** `$text` can't return matches in date order: a common word means sorting every match.
   Move to OpenSearch or Atlas Search, fed from MongoDB change streams.
5. **MongoDB writes and storage.** Shard by the key each hot query filters on, so queries hit one shard:

   | Collection    | Shard key                                                        | Why                                                   |
   | ------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
   | posts         | `{authorId: 1, _id: 1}`                                          | profiles and per-author feed merges stay on one shard |
   | follows       | `{followerId: 1}` (+ a copy by followee, or a second collection) | both directions are hot; one key can't serve both     |
   | likes         | `{postId: 1}`                                                    | per-post lists and "did I like it" lookups            |
   | messages      | `{conversationId: 1, _id: 1}`                                    | a conversation's history on one shard                 |
   | notifications | `{recipientId: 1, _id: 1}`                                       | a user's list on one shard                            |

   Hashed keys spread writes better but scatter range queries, so they suit only point lookups.

6. **Counters on very hot rows.** One viral post takes thousands of `$inc` per second on the same
   document. The fix is sharded counters (N sub-counters summed on read) or buffering increments in Redis
   and flushing periodically.

## By order of magnitude

- **Up to ~100k users (now).** One API instance pair, one worker, one replica set, one Redis. The design
  limits here are the per-machine numbers above.
- **~1M users.** Several API instances and workers, MongoDB read replicas, Redis split into cache and
  queue instances, CDN for the web app, search moved to a search engine.
- **~10M+ users.** Sharded MongoDB, Redis Cluster, feed fan-out as its own service with its own queue
  partitions, celebrity threshold tuned from data, notification and message storage tiered (old data to
  cheaper storage), regional deployments with users pinned to a home region.

## What wasn't measured

Socket.IO connection capacity (needs many client machines), multi-instance behaviour under load (one
machine), and anything on production hardware. These numbers show where latency bends on one laptop,
not capacity.
