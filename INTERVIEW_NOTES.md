# Interview notes

Explanations of each subsystem and the questions an interviewer is likely to ask about it.

## Foundation (Phase 2)

### Request pipeline

`request id → logging → helmet → CORS → JSON parser (100 kb) → health → timeout → routes → 404 → error handler`

**Why validate with a wrapper instead of trusting `req.body`?** Controllers only receive the output of a
Zod schema. Unknown keys and operator objects like `{ "$gt": "" }` are rejected before reaching Mongoose,
which closes the classic NoSQL-injection hole (`User.findOne({ username: req.body.username })` where the
username is an object).

**Why one error envelope?** Clients branch on a stable `code`, never on messages. Unexpected errors become
a generic 500 so stack traces, query text and secrets never leak; the full error is logged with the request id.

**Q: A unique-index violation reaches the error handler. What happens?** It becomes a 409 without echoing the
duplicated value. Services handle the cases they expect (e.g. "username taken") explicitly; the fallback
only ensures an unanticipated race isn't reported as a server bug.

### Pagination

Cursor-based, not offset-based. `skip(n)` is O(n) (MongoDB walks and discards n index entries) and gives
duplicated or missing items when rows are inserted between page loads. A cursor encodes the sort key of the
last item, so the next page is an index range scan starting exactly there: O(log n + page size).
Fetching `limit + 1` rows reveals whether another page exists without an O(n) count query.

**Q: Cursors aren't signed. Is that a problem?** No. A tampered cursor still has to pass the schema, so it can
only point to a different position in a list the caller is already authorized to read. Authorization never
depends on the cursor.

### Health checks

- **Liveness** checks only the process. If it depended on MongoDB, a database outage would make the
  orchestrator restart every healthy API instance: a restart storm that fixes nothing.
- **Readiness** checks dependencies with a per-check timeout (a hung Redis can't hang the probe) and fails
  during shutdown so the load balancer stops routing traffic before the server closes.

### Graceful shutdown

On SIGTERM: fail readiness → stop accepting connections and wait for in-flight requests → close Redis →
close MongoDB. A watchdog forces exit if draining exceeds the configured timeout.
`keepAliveTimeout` (65 s) is set above typical load-balancer idle timeouts (60 s) to avoid the race where the
server closes a socket the LB is about to reuse, which surfaces as sporadic 502s.

### Redis client policy

Request-path clients use `maxRetriesPerRequest: 2` so an outage fails fast and the caller can degrade (e.g.
fall back to MongoDB). BullMQ workers need `maxRetriesPerRequest: null` for blocking commands. Redis runs with
`noeviction` because evicting a queue key silently loses jobs. In production, cache and queues belong on
separate instances so the cache can use LRU eviction.

### MongoDB as a replica set, even locally

Multi-document transactions (block user = delete two follow edges + insert block) require a replica set.
Running one node as a replica set in development and tests keeps behaviour identical to production.

## Authentication and users (Phase 3)

### How a request is authenticated

`Authorization: Bearer <Clerk session JWT>` → `verifyToken` (RS256 signature, `exp`/`nbf`, `azp` must be
our frontend) → `sub` claim → local user (Redis cache → MongoDB → provision from Clerk) → `req.user`.
Identity comes only from the verified `sub`. Bodies are validated with strict schemas, so a client
sending `clerkId`, `_id` or `counts` gets a 400, never a write.

**Q: Why verify `azp`?** A valid Clerk token minted for a different frontend on the same Clerk instance
would otherwise be accepted. `azp` binds the token to our origin.

**Q: Networkless vs JWKS verification?** With `CLERK_JWT_KEY` the PEM key verifies locally: no network hop,
no dependency on Clerk's availability per request. Without it the SDK fetches JWKS and caches it.
Session tokens live ~60s, so revocation lag is bounded by that lifetime.

### Lazy provisioning and webhooks

Webhooks can be delayed, duplicated or reordered, so sign-in must not depend on them. The first
authenticated request creates the user from Clerk's API. Webhooks then keep email/avatar in sync and
propagate deletions.

- **Duplicates:** handlers are idempotent upserts.
- **Reordering:** each write is conditional on `clerkUpdatedAt < event.updated_at`. If the stored row is
  newer, the filter matches nothing, the upsert tries to insert, and the unique index on `clerkId` rejects
  it. That duplicate-key error is interpreted as "stale event, ignore".
- **Delete before create:** deletion upserts a tombstone, so a late `user.created` cannot resurrect it.
- **Security:** HMAC signature over `id.timestamp.body` (raw bytes, so the router is mounted before the
  JSON parser) plus a timestamp tolerance against replay.

**Q: Ten requests from a brand-new user arrive at once. What happens?** All miss the cache, all call the
provider, all upsert. The unique index lets exactly one insert win; the rest get E11000, are treated as
"already exists", and re-read. Tested: 10 concurrent requests → 1 document.

### Username uniqueness

A partial unique index on `username` (only documents where it is a string, since it's absent before
onboarding) is the source of truth. The availability endpoint is advisory (time-of-check vs time-of-use);
the claim is `findOneAndUpdate({ _id, username: { $exists: false } })`, which makes onboarding a one-shot
transition and maps E11000 to `409 USERNAME_TAKEN`. Tested: two concurrent claims → one 200, one 409.
Usernames are lowercased by the schema so case variants can't coexist, and route names are reserved
because profiles live at `/:username`.

### Auth-user cache

Every authenticated request maps `clerkId → user`. Cache-aside in Redis with a 5-minute jittered TTL
(jitter avoids synchronized expiry). Values are re-validated with Zod on read and keys are versioned
(`v1:`), so a deploy that changes the shape can't crash on old entries. Invalidation happens on rename
and deletion; if a DEL fails, staleness is bounded by the TTL. Redis down → read MongoDB (logged).
`null` is not cached, so a user provisioned right after a miss is visible immediately.

### Rate limiting: sliding-window counter in Lua

| Algorithm                  | Memory per key      | Accuracy                                      |
| -------------------------- | ------------------- | --------------------------------------------- |
| Fixed window               | O(1)                | Allows 2× limit across a boundary             |
| Sliding log (ZSET)         | O(limit)            | Exact                                         |
| **Sliding-window counter** | O(1) (two counters) | Approximate (assumes uniform previous window) |

Estimate = `previous × (remaining fraction of window) + current`. Running it as one Lua script makes
check-and-increment atomic (tested: 50 concurrent requests at limit 10 → exactly 10 allowed). Time
comes from Redis `TIME`, so API instances with skewed clocks agree. `EVALSHA` sends a 40-byte hash; on
`NOSCRIPT` (after a Redis restart/failover) it falls back to `EVAL`.

**Q: Redis is down. Do requests fail?** No: the limiter fails open and logs. Rejecting all traffic
because the limiter's store is down would turn a cache outage into a full outage. Endpoints where abuse
is costlier than downtime should fail closed instead.

**Keying:** per user after authentication (fair behind shared NATs), per IP before it (bounds token
verification work from anonymous traffic). `TRUST_PROXY` must match the number of proxies, or every
client appears as the load balancer's IP.

### Frontend auth flow

Clerk handles credentials and sessions; the API client asks Clerk for a fresh token per request (Clerk
caches it). Route guards are UX only; the server enforces everything. On sign-out the query cache is
cleared so the next account on a shared device never sees the previous account's data. The privacy
toggle is optimistic with rollback; profile edits send only dirty fields.

## Social graph and content (Phase 4)

### Data model: edges, not arrays

Follows, likes, bookmarks and comments are separate collections with one document per edge, never
arrays on the user or post. Arrays would be unbounded (a celebrity's followers exceed the 16 MB document
limit), every write would rewrite one hot document, and paging an embedded array can't use an index.
Counts are denormalized onto the parent (`users.counts`, `posts.counts`) so rendering is O(1).

### Counters without transactions

A like is an upsert on the unique `{postId, userId}` index followed by `$inc` **only if this call
inserted** (`upsertedCount === 1`); unlike decrements only if `deletedCount === 1`. The rule is
_edge ownership_: whoever creates an edge adds one, whoever actually removes it subtracts one.
Tested: 20 concurrent likes from one user produce 1 like and a count of 1; 12 users liking while 5 of them
double-unlike leaves exactly 7.

**Q: Why not a transaction?** A popular post's counter document would be written by every liker; under
snapshot isolation concurrent transactions touching it hit WriteConflict and retry, so throughput
collapses exactly where traffic is highest. Plain `$inc` is atomic and contention-friendly. The cost is
a tiny drift window if the process dies between the two writes, repaired by a reconciliation job.

### Visibility as one pure policy

`canSeeProfile`, `canViewContent`, `canInteract`, `canReshare`, `canFollow` take an already-loaded
relationship and author. Every module calls them; none re-implements the rules. Invisible posts return
**404, not 403**, so a private or blocking account's content can't be probed for existence.

### No N+1: batch hydration

Turning a page of posts into DTOs costs about 8 queries **regardless of page size**: shared posts, authors,
relationships (blocks both ways, my follows, their follows), and the viewer's likes, bookmarks and reposts,
each one `$in` over the page. Hydration also re-checks visibility, because lists like bookmarks (and the
Phase 5 feed's cached id lists) can contain posts whose author has since gone private, blocked the viewer
or been deleted. A mutation test proved this mattered: removing the check made the bookmarks test fail.

### Bug found: snapshot isolation broke the follow/block race argument

Concurrent "B follows A" and "A blocks B" could leave B following A. The original design was
_insert, then check_: follow inserts its edge then looks for a block; block inserts the block then deletes
edges; in every interleaving one side should see the other. That argument assumes each operation sees the
latest committed data immediately. **The block runs in a transaction**: its block row is invisible until
commit, and its edge delete reads the transaction's snapshot, which predates an edge inserted
mid-transaction. Both sides missed each other.

Fix: after commit, block runs a non-transactional sweep of edges between the pair. A follow either checks
after the commit (sees the block, removes its own edge) or inserted before the commit (the sweep, reading
the latest data, removes it). Counter decrements still follow edge ownership. A stress test of 30
independent races per run caught it; removing the sweep makes it fail 3/3, with it 120/120 pass.

**Interview takeaway:** transactions give atomicity and a consistent snapshot, not linearizability against
writers outside the transaction. Reasoning about races that mix transactional and non-transactional
writes has to account for when each side's writes become visible.

### Bug found with explain(): a partial index that was never used

`username` had a _partial_ unique index (`{ $type: 'string' }`) because users have no username until
onboarding. Seeded data plus `explain()` showed every profile lookup was a **COLLSCAN**: the planner uses a
partial index only when it can prove the query matches the filter, and it doesn't infer that
`username = 'x'` implies a string. Switched to a **sparse** unique index: same exclusion of missing
fields, usable for equality. Lookup went from scanning every user to 1 key / 1 document. Index changes ship
via `npm run db:sync-indexes` because production runs with `autoIndex` off.

The other partial index (one plain repost per user per post, `{ kind: 'repost' }`) is fine: every query
against it includes `kind: 'repost'`.

### Index design (all verified with explain on seeded data)

| Query                  | Index                                                | Plan                    |
| ---------------------- | ---------------------------------------------------- | ----------------------- |
| Profile timeline       | `posts {authorId, createdAt -1, _id -1}`             | IXSCAN, keys = returned |
| Followers list         | `follows {followeeId, status, createdAt -1, _id -1}` | IXSCAN, keys = returned |
| Top-level comments     | `comments {postId, parentId, createdAt -1, _id -1}`  | IXSCAN, keys = returned |
| Hashtag page           | `posts {hashtags, createdAt -1, _id -1}` (multikey)  | IXSCAN, keys = returned |
| "Did I like these 20?" | `likes {postId, userId}` (the unique index)          | IXSCAN, point lookups   |

Equality fields first, then the sort keys (ESR rule), so a page is an index range scan of `limit + 1`
entries with no in-memory sort. A separate `{userId, postId}` like index was removed: the unique index
already answers the batch lookup, and every extra index adds write cost to each like.

### Two-level comment threads

Replies attach to the top-level comment, so a thread page is one range scan (`parentId` index), not a
recursive `$graphLookup`. Blocked users' comments are filtered after the query (the block list is
unbounded, so `$nin` over it isn't viable); pages can come back short, but `nextCursor` comes from the
unfiltered rows, so pagination stays correct.

### Seed data you can trust

The seed derives every counter from the edges it creates, recomputes counters for real accounts it
touches (an earlier version incremented them and drifted on re-runs, caught by a consistency check), and
is deterministic (all randomness goes through a seeded faker; `Math.random` defeated that in the first
version).
