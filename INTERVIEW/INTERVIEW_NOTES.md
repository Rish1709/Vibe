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

## Home feed (Phase 5)

Full design and trade-off table: [caching-strategy.md](caching-strategy.md).

### The design in one paragraph

Hybrid fan-out. Ordinary posts are **pushed**: a BullMQ worker writes the post id into each follower's
Redis sorted set (score = createdAt), capped at 800. Celebrity posts (author ≥ 10k followers at publish
time) are flagged `fanoutSkipped` and **pulled** at read time through a partial index holding only those
posts. A page = timeline entries ∪ pulled entries, merged by `(createdAt, _id)`, then hydrated with
visibility re-checked. MongoDB is the source of truth: missing timelines are rebuilt from it, pages past
the cap continue from it, and if Redis is down the whole feed comes from it.

### Likely questions

**Q: Why not just pull?** `posts.find({ authorId: { $in: following } }).sort(...)` is a SORT_MERGE over one
index range per followee. Cost grows with the number followed (see the benchmark), and it's paid on every
page load, which happen far more often than posts.

**Q: Why not just push?** One post by an account with 10M followers would be 10M Redis writes. Push cost is
proportional to followers, pull cost to followings; the hybrid caps both.

**Q: What does a timeline store?** Ids only. Content is hydrated per request, which also re-checks blocks,
privacy and deletion. That is why invalidation can be lazy (delete and rebuild) without ever leaking.

**Q: What if Redis loses everything?** Every timeline is rebuilt from MongoDB on its owner's next read.
A thundering herd after a full flush is the risk: the per-user rebuild lock prevents duplicate rebuilds for
one user, and readers that lose the lock are served straight from MongoDB.

**Q: How do you paginate across two sources?** One cursor format, `(t, id)` = (createdAt ms, _id), used by
MongoDB (`createdAt < t OR (createdAt = t AND _id < id)`) and Redis (`ZRANGE ... BYSCORE REV` from `t`,
skipping ties at `t` with id ≥ cursor id). Both sort identically (ties broken by id descending), so the
merge is a plain k-way merge and a page can mix sources. Scrolling past the 800-entry cap continues from
MongoDB with the same cursor. Tested with 830 posts.

**Q: How do you know there's a next page without counting?** Each source returns `limit + 1`; if the merged
list has more than `limit`, there is.

**Q: Ranking later?** `FeedRanker` sits between merge and pagination (chronological = identity). A real
ranker changes the cursor: "older than t" no longer describes the next page, so you'd paginate by
(score, id) or snapshot a ranked candidate list per session.

### Bugs found while building it (good interview stories)

1. **Redis deletes empty sorted sets.** A user whose followees hadn't posted got an empty timeline and the key
   vanished. Fan-out only writes to existing timelines, so it skipped them, and every read rebuilt. Fix: a
   permanent `~anchor` member at a negative score (rank 0; trimming starts at rank 1).
2. **Celebrity status changing under a stale cache.** Readers decided "who is a celebrity" from a cached
   author list. When an author crossed the threshold, their next post was neither pushed (writer: celebrity)
   nor pulled (stale reader: not a celebrity). Fix: record the decision on the post (`fanoutSkipped`) and pull
   exactly those posts. Correct in both directions, and the reader no longer needs follower counts.
3. **BullMQ 6 rejects `:` in custom job ids**, so every enqueue threw. Feed errors are deliberately logged,
   not thrown (feed upkeep must never fail a post), and rebuilds made feeds look right, so fan-out was
   completely broken while every visible test passed. Fix: `-` separator, plus a test asserting jobs
   complete. Lesson: graceful degradation needs a test that fails loudly when the background path breaks.
4. **Cache-fill races,** handled by design rather than found: a post published mid-rebuild (the rebuild
   creates its key first, so fan-out lands in it) and an unfollow mid-rebuild (version counter checked
   atomically at commit). Both are tested by pausing a real rebuild between its MongoDB query and its
   Redis write.

All four guards, plus the rebuild lock, were mutation-checked: removing each makes its test fail.

### Complexity summary

| Operation                   | Cost                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| Read a page (timeline path) | O(log T + L) Redis + O(F_celeb + L) MongoDB + hydration (constant queries) |
| Read a page (pull path)     | O(F) index seeks + O(L)                                                    |
| Publish (ordinary author)   | O(1) on the request; O(followers) in the worker, batched 500 per pipeline  |
| Publish (celebrity)         | O(1)                                                                       |
| Follow / unfollow           | O(1): delete the timeline; O(F + T) later on rebuild                       |
| Memory                      | ~64 B × 800 ≈ 50 KB per **active** user (inactive timelines expire)        |

F = followings, T = timeline size, L = page size.

## Media and stories (Phase 6)

### Upload flow: the API never touches file bytes

1. `POST /media/uploads {purpose, mimeType, size}` validates the declaration and returns signed ImageKit
   credentials: `signature = HMAC-SHA1(privateKey, token + expire)`, a single-use token, 30-minute expiry,
   plus the folder (`/vibe/users/{userId}/{purpose}`) and file name (the media id) to use.
2. The browser uploads directly to ImageKit (XHR, for progress).
3. `POST /media/uploads/:id/complete {fileId}`: the server fetches ImageKit's **own record** of the file and
   checks name, folder, MIME type, kind and size before marking it ready.

**Q: Why re-check after upload when you validated before?** The signature proves we authorized _an_
upload, but the folder, name, type and size are chosen by the client. A malicious client can upload a
100 MB file after declaring 1 KB, or put it in someone else's folder. Step 1 is for fast feedback; step 3 is
the security boundary. Tested by simulating each tampering; each is rejected and the stored file deleted.

**Q: Why not proxy uploads through the API?** Proxying doubles bandwidth, ties up API memory and sockets
for slow uploads, and makes the API the bottleneck. Direct-to-CDN keeps the API stateless and cheap.

**Q: Why no SDK?** Signing is one HMAC and the API needs two REST calls (details, delete). Built-in
`crypto` and `fetch` are enough, so there's one less dependency to audit and update.

### Media lifecycle and ownership

`pending → ready → attached → released`, each a conditional update. Attaching is `findOneAndUpdate({ status:
'ready' } → 'attached')`, so two concurrent posts can't share one upload (tested: one 201, one 400). A
unique index on `fileId` stops one stored file from backing two records. A failed post creation un-claims its
media so the user can retry with the same uploads.

**Q: How do files get deleted?** A BullMQ job scheduler runs hourly cleanup in the worker: abandoned uploads
(pending or ready for 24h), released files (deleted posts, replaced avatars, deleted stories), and story
media 48h after attaching. A record is deleted only after its CDN file is gone (404 counts as gone), so a
crash or failure just retries next hour. `upsertJobScheduler` is idempotent, so every worker can declare the
schedule and BullMQ still runs it once per interval.

**Embedding vs referencing:** posts and stories embed a media snapshot (url, kind, dimensions). Media is
bounded (≤4 per post), always read with its parent, and immutable after upload, so a separate lookup per
render would only add a query.

### Stories: 24 hours, enforced in queries

Every story query filters `expiresAt > now`. The TTL index (`expireAfterSeconds: 0`) only deletes the
documents later: MongoDB's TTL monitor runs about once a minute and can lag further under load, so relying on
it would show stories past their 24 hours. Tested by backdating `expiresAt` on a story the TTL hasn't
deleted yet: it vanishes from the tray, profile, views and viewer list.

**Tray query:** `{ authorId: { $in: [self, ...followees] }, expiresAt: { $gt: now } }` on index
`{ authorId: 1, expiresAt: 1 }` (equality then range, the ESR rule), then authors, relationships and the
viewer's views in batch. Constant query count regardless of followings. Rings with unseen stories sort first.

**Views:** unique `(storyId, viewerId)` plus increment-only-on-insert, the same pattern as likes (tested: 3
viewers × 2 concurrent views each = 3). Views carry the story's `expiresAt`, so they expire with it. Only the
author sees the viewer list.

### Delivery: ImageKit transforms

The frontend requests `url?tr=w-640,q-80,f-auto` with a `srcset` of widths, so ImageKit resizes, picks
WebP/AVIF per browser and caches each variant at the edge. Phones download a ~640 px image instead of the
original. Video posters come from `.../ik-thumbnail.jpg`.

### Bug found by a test

The story tray put `role="listitem"` on each ring's `<button>`, which overrides the button role: screen
readers wouldn't announce the rings as clickable. The UI test couldn't find them either, for the same reason.
Fixed with a real `<ul>`/`<li>` around buttons.

**Mutation-checked:** query-time expiry, view dedup, the upload folder check, atomic claiming.

### Bugs found in live testing (not by the tests)

**Old posts crashed the feed.** Posts written before Phase 6 had no `media` field. Mongoose fills
schema defaults when it builds documents, but `.lean()` reads return the raw BSON, so `post.media` was
`undefined` and the hydrator threw on `.map`. Every test created fresh posts, so none had the old shape.
Fix: fields added after documents existed are typed optional (`media?:`), so the compiler pointed at
every reader (two: hydration and delete), and a test unsets the field to recreate an old document.
The general lesson: adding a field is a schema migration even in a "schemaless" database. Either
backfill it, or make every reader tolerate its absence; doing both is safest.

**A slow ImageKit response became a 500.** The upload verification lookup hit its 5 s timeout and the
raw `TimeoutError` surfaced as an internal error. Fix: idempotent ImageKit calls (lookup, delete) retry
once on timeout, network error, 429 or 5xx, with per-attempt timeouts that fit inside the API's request
timeout. A typed `MediaProviderUnavailableError` becomes a 503 `SERVICE_UNAVAILABLE`. The upload stays
`pending`, so verification can simply be repeated, and the browser retries it once before giving up
instead of making the user upload the file again.

## User search (Phase 8 preview)

`GET /api/v1/search/users?q=` finds people by `@username` prefix or by the start of any word in their
display name ("hop" finds Grace Hopper, "gr hop" too, "jose" finds José).

**Why not a case-insensitive regex?** `/^gra/i` can't be turned into index bounds, so MongoDB scans the
whole index (or collection) for every keystroke. An anchored, case-sensitive prefix on normalized data
_can_: `^gra` becomes the range `["gra", "grb")`. So:

- Usernames are already stored lowercase, so the unique `username` index serves `^prefix` directly.
- Display names are stored a second time as `searchTokens`: the distinct words, lowercased, with
  accents stripped (NFKD), in a multikey index. Multi-word queries use `$all` of prefixes.
- Both lookups run in parallel and are merged in memory: exact handle, then handle prefix, then name
  match; ties by follower count. Verified with `explain()`: IXSCAN, documents examined = returned.

**Keeping the copy correct.** Every write of `displayName` goes through one helper that also writes
`searchTokens`, so they can't drift. Existing accounts are filled by an idempotent, batched backfill
(`db:backfill-search`) that re-checks the condition per document, so it never overwrites a rename that
happened while it ran.

**Privacy.** Private accounts are findable (that's how you request to follow them), flagged with
`isPrivate` so the UI can show a lock. Accounts that blocked you, or that you blocked, are left out, like
everywhere else. Queries are regex-escaped (`a.` must not match `axb`) and rate limited.

**Limits and what's next.** Prefix matching only: no typo tolerance and no ranking by relevance beyond the
rules above. At scale this moves to a search engine (Atlas Search or OpenSearch with edge n-grams),
fed by change streams. Phase 8 adds posts and hashtags.

## Real-time messaging and notifications (Phase 7)

### Architecture in one paragraph

Durable writes go through REST; sockets only push. Sending a message is `POST /conversations/:id/messages`:
validated, rate limited, idempotent, persisted, and only then pushed to both participants' sockets. If a
push is lost (offline, reconnecting), nothing is lost: the client refetches what pushes would have changed
on every reconnect. Socket.IO runs on every API instance with the **Redis adapter**, so an emit on
instance A reaches a socket held by instance B (tested with two real instances). The worker has no
sockets and publishes through the **Redis emitter**. Each socket joins a `user:<id>` room, so one emit
reaches all of a user's tabs and devices.

### Why REST for sends, not a socket event?

- One write path with the same auth, validation, rate limits and error envelope as everything else.
- Retries are explicit: the client generates a `clientId` (UUID) per message, and a unique index on
  `(senderId, clientId)` turns a retried or double-tapped send into the same message with no repeated
  side effects (tested with five concurrent retries: one message, unread count 1).
- Sockets stay stateless and cheap: only pushes and ephemeral signals (typing).

### Socket authentication

The handshake carries a Clerk session token, verified exactly like a REST bearer token, and the user must
be onboarded. Rejections carry a code (`UNAUTHENTICATED`, `ONBOARDING_REQUIRED`, `ACCOUNT_DELETED`) so the
client can tell "sign in again" from a network error. A socket is trusted for its lifetime: tokens live
about a minute, so re-verifying would force constant reconnects. Instead, account deletion disconnects the
user's sockets, and every reconnect presents a fresh token (the client's auth callback runs per attempt).
WebSocket transport only: no long-polling, so no sticky sessions are needed at the load balancer.

### Data model

- **Conversation**: one per pair; `key` = the two ids sorted, unique. "Open a conversation" is an upsert,
  so ten concurrent opens from both sides create one (tested). Per-member `unread` and `lastReadAt` live
  in a two-element array updated with `arrayFilters`; `lastMessage` is denormalized for the inbox.
- **Message**: `{conversationId, createdAt, _id}` index for the thread (keyset, newest first).
- **Inbox**: `{participants, lastMessageAt, _id}`, keyset on `lastMessageAt` (the keyset helper gained a
  field parameter).

**Concurrency.** Concurrent sends each `$inc` the recipient's unread count, which stays exact (12 concurrent
sends give 12). The preview is set by a _conditional_ update (`lastMessageAt <= mine`), so the older of two
racing messages can't overwrite the newer preview.

**Message policy.** "Everyone" or "people I follow"; blocks forbid messaging both ways. Exception: if
someone wrote to you first, you may answer whatever your policy says, otherwise a "following only"
account could message people who can't reply.

### Notifications: queue, dedupe, and the undo race

A like enqueues a BullMQ job and returns; the worker creates the notification and pushes the new unread
count. Notifications must never fail the action that caused them: an enqueue error is logged and dropped
(the transactional outbox is the upgrade path for durability).

- **Dedupe**: a `dedupeKey` (type, actor, target), unique per recipient. A retried job, or like, unlike,
  like again, leaves exactly one notification. Completed jobs are removed at once, so the BullMQ job id
  can't swallow a legitimate later event.
- **The undo race**: an unlike lands while the job runs. The fix is "insert, then check": the worker
  inserts the notification and then re-checks that the like still exists; the unlike deletes the like and
  then the notification. In every interleaving one side sees the other. A test makes the worst case
  deterministic (the unlike lands between insert and re-check) and fails if the re-check is removed.
- **Read-time visibility**: blocked actors, deleted accounts and deleted posts drop out when listing.

### Background jobs

- **Post cascade**: deleting a post is instant (a soft delete; reads already hide its likes and comments).
  A job then removes likes, bookmarks, comments and notifications in batches of 1,000 ids. It is
  idempotent and refuses to touch a post that isn't deleted. It needed a new `bookmarks.postId` index:
  the unique index leads with `userId`, so it can't serve a lookup by post.
- **Counter reconciliation** (daily): recomputes followers, following, posts, likes, comments and reposts
  from the edges, with the same rules as the live `$inc`s. The hazard: an edge write and its `$inc` are
  two steps, so a counter read between them looks wrong but is about to be right, and "fixing" it would
  create drift. So each batch is measured twice, a couple of seconds apart, and only **quiet** counters
  (unchanged across both readings) that are still wrong are corrected, with a write conditional on the
  stored value. A test injects a like between the measurements and fails if the quiet rule is removed.

### Surprises worth telling

- **The test suite starved itself.** Four new files with concurrency stress tests, eleven files in
  parallel against one in-memory mongod with 3 GB free: requests hit the 5 s timeout, a different set each
  run. Capped at four parallel files; the stress tests stay exactly as strict.
- **Socket.IO ignores an async middleware's promise**, so a thrown error would leave the handshake
  hanging. Authentication resolves to "user or error" and never rejects.

### Limits and next steps

- One-to-one conversations only; groups need a membership collection and per-member fan-out.
- No notification grouping ("Ada and 5 others liked your post").
- Pushes aren't queued for offline users; reconnect-and-refetch covers the web app. Mobile push would add
  a per-device delivery queue.

## Search and discovery (Phase 8)

### Post search: MongoDB `$text`, measured before trusting

`GET /search/posts?q=` finds posts containing **every** word, newest first, with keyset pagination. Each
word becomes a quoted phrase, and `$text` ANDs multiple phrases. User input can't inject `$text` syntax:
quotes and the leading `-` (negation) are stripped first. A lone `#tag` is routed to the hashtag index.

The index language was chosen by experiment against real MongoDB, not by default:

| Query                | `english` index                                                          | `none` index    |
| -------------------- | ------------------------------------------------------------------------ | --------------- |
| "running park" (AND) | correct                                                                  | correct         |
| "run"                | also finds "running" (stemming)                                          | exact word only |
| "the park"           | **nothing**: stop words aren't indexed, and the phrase "the" can't match | correct         |

Found later on live data: phrases are verified as substrings, so once one word matches a whole word, the
others can match inside longer words ("ipsa statua" also found "ipsam ... statua"). Harmless, close to
prefix matching, and now documented rather than claimed away.

A search box where "the park" returns nothing is a bug users would hit daily, so the index uses
`none`: every word indexed as written, in any language, no stemming. The trade-off is written next to
the index definition. Changing a text index's options means dropping and rebuilding it, which
`db:sync-indexes` does as an explicit deploy step (the dev database needed exactly that).

**Cost, honestly.** `$text` can't return matches in date order, so MongoDB collects every match and
sorts them: O(matches) per page. Fine at this size; a common word over millions of posts isn't. The
upgrade path is a search engine (Atlas Search or OpenSearch) fed by change streams, which also brings
relevance ranking, typo tolerance and prefix search.

**Visibility** is re-checked by the same hydration as every list, so private posts appear only to
approved followers, and deleted posts and plain reposts never appear.

### Hashtag pages

`GET /hashtags/:tag/posts` uses the `{hashtags, createdAt, _id}` index planned back in Phase 4: an index
range scan, already in date order (explain shows no SORT stage). Tags are case-insensitive (`#Vibe`,
`vibe` and `VIBE` are one page). Hashtags and @mentions in posts are now links, except inside a quoted
post, which is itself a link (links can't nest).

### Trending hashtags

- **Ranked by distinct authors, then posts.** One account posting `#deal` a hundred times counts as one
  author; three people using `#worldcup` once each outrank it. Tested, and mutation-checked.
- **Private accounts are excluded.** Their hashtags would otherwise leak onto everyone's Explore page
  (think `#surpriseparty`). Also mutation-checked.
- **The window uses the `_id` index.** An ObjectId starts with its creation time, so
  `_id >= ObjectId(now - 7 days)` is an index range over recent posts, with no `createdAt` index. The
  `createdAt` condition is still applied, for documents whose ids don't match their dates (imports,
  backdated seed data).
- **Cached for 5 minutes** (cache-aside): everyone sees the same list, and trends move slowly.
- The window is a week because the network is young; a busy network would use hours and add time decay.

### Who to follow

- **Friends of friends:** accounts followed by the people you follow, ranked by how many of them do
  ("Followed by 2 people you follow"). Seeded from at most 200 of your most recent followees, so a
  user who follows 10,000 accounts doesn't run an unbounded aggregation.
- **Popular accounts** fill the list for newcomers who follow nobody, via a partial index on
  `counts.followers` that holds only active, onboarded accounts.
- **Cache the expensive part, filter the volatile part live.** The candidate list is cached per user
  for 10 minutes; follows, pending requests and blocks are checked on every read. So someone you just
  followed disappears from suggestions at once, without invalidating anything.

### A regression caught by an existing test

Splitting search into People and Posts tabs moved the debounce into a child component that mounts on
the first keystroke. A debounce starts from its initial value, so "p" was searched immediately instead
of waiting for "priv". The Phase 6 search test (which asserts exactly one request) failed, and the fix
was to debounce once, at the page, which is always mounted.

## Hardening: security, performance, failure UX (Phase 9)

### Authorization as an executable matrix

Per-feature tests already checked "can't edit someone else's post". The gap is the endpoint nobody
thought to test. `authorization.test.ts` sets up one private account with a post, a comment, a story, a
conversation, an unused upload and a pending follow request, then tries **every** read and write route
against them as two attackers: a stranger and an account the owner blocked.

- Every row must be refused with 403 or 404 (400 only where the input itself is the problem). A 2xx
  fails the test, and so does a 5xx, which would be a crash rather than a refusal.
- **A positive control runs first:** an approved follower reads the same URLs and must get 200.
  Without it, a typo in a path would 404 for everyone and the row would pass.
- After the writes, the database is checked: text unchanged, no likes, no repost, no reply, message
  count unchanged, upload still unattached, follow request still pending. A response code alone can
  lie (a 404 _after_ the write happened).
- **Side doors are rows too:** replying to the private comment through the attacker's own public post
  (`parentId` from another post), quoting the private post, attaching someone else's upload to a new
  post or story.
- Search, hashtag pages and trending must not surface the private post either.

**Mutation-checked:** removing the author check on edit, the same-post check on replies, or the owner
check on media each makes the matrix fail. These guards already existed. The matrix makes sure they
can't be lost in a refactor.

Other review results:

- **Dependencies:** `npm audit --omit=dev` finds 0 vulnerabilities in what ships. The 10 dev-only
  findings are one `minimatch` ReDoS inside eslint. Lint only reads our own files, and the offered
  fix is a major downgrade, so it's accepted and recorded here.
- **WebSockets:** Socket.IO's CORS setting doesn't apply to WebSocket upgrades. Cross-site WebSocket
  hijacking still isn't possible, because the socket authenticates with a token in the handshake,
  not with a cookie the browser would attach automatically.
- **Inputs:** every route parses params, query and body through zod (`validated()`); handlers never
  read raw `req.query` or `req.body`, so operator injection (`{"$gt": ""}`) has nowhere to land.

### Query plans, measured by the profiler

Indexes were designed per feature, but a design is a claim. `queryPlans.test.ts` turns on MongoDB's
profiler, drives a tour of the app through the real API (follows and requests, posts with media,
likes, reposts, quotes, comments and replies, feed, stories, hashtags, search, suggestions, messages,
notifications, deletes), and fails on any query that:

- **scans a collection** (`COLLSCAN`): cost grows with the whole collection, not the result; or
- **sorts in memory** (`hasSortStage`): every match is held and sorted before the first row is
  returned, and MongoDB aborts past 100 MB.

Neither shows up at test sizes, which is why it's checked by plan rather than by timing. Exceptions
are listed in the test, each with its reason: `$text` search (unordered by design), trending (a
cached weekly aggregate) and who-to-follow (it ranks counts it just computed, which no index can hold).

**It found three in-memory sorts, all in stories.** They were sorted by `createdAt` while the index was
`{authorId, expiresAt}`. Every story expires exactly 24 hours after it's posted, so expiry order _is_
posting order:

- A profile's stories now sort by `{expiresAt, _id}` on a `{authorId, expiresAt, _id}` index: read in
  index order, no sort. Reverting the sort makes the test fail again (mutation-checked).
- The tray returns every active story of everyone you follow, with no page, so it's sorted in the API.
  That costs the same as sorting in MongoDB, and doesn't depend on the planner choosing the compound
  index for an `$in` (with tiny data it chose the expiry-only index instead).

Changing an index's key means a rebuild; `db:sync-indexes` dropped the old one on the dev database.

**Not done: load testing.** Throughput numbers from a laptop running Mongo, Redis, the API and the
browser at once would be fiction. Load tests belong against the deployed stack in Phase 10.

### A button that spins forever (found by the user)

Edit and delete hung on a bad connection with no server logs. The API logs every request and times out
at 15 s, so "no logs" meant the request never left the browser. Two client-side causes:

- **React Query pauses requests while the browser reports being offline** (`networkMode: 'online'`,
  the default). The mutation stays "pending" and never sends. Now `networkMode: 'always'`: send
  anyway, and let a failure show as an error with a retry. `navigator.onLine` is also unreliable (it
  reports "online" on Wi-Fi with no internet), so it's a poor gate.
- **No deadline on the call.** Getting a Clerk token and the fetch itself could both wait forever. One
  20 s deadline now covers token, request and response body. It's longer than the server's 15 s so a
  slow server answers with its own 503 first. A cancel by the caller is still reported as a cancel.

Tested with a fetch that never answers and a token that never arrives (both fail without the
deadline). Delete also gained the error toast it was missing.

### Why #jaihind didn't trend (not a bug)

Of the 11 posts, 7 came from a private account, which trending ignores by design. That left one public
author with 4 posts, ranking 11th behind seeded tags used by two to four different people, one place
outside the top 10. Ranking by distinct authors is the point: one account repeating a tag shouldn't be
able to make it trend.

## Delivery: Docker, CI/CD, load testing (Phase 10)

### Images

- **One multi-stage `Dockerfile`, three targets.** Dependencies install from manifests before any
  source is copied, so a code change reuses the cached `npm ci`. The API image holds production
  dependencies and compiled JavaScript only (no compilers, test tools or web packages), runs as the
  non-root `node` user, and declares a liveness health check.
- **The worker is the API image with another command.** They can't drift apart on models or job formats.
- **Liveness, not readiness, in the container health check.** If MongoDB blips, a readiness-based check
  would make the orchestrator restart healthy API processes, which helps nothing and drops sockets.
- **The web image is unprivileged nginx** serving the build and proxying `/api` and `/socket.io`. The
  browser sees one origin (no CORS preflights), `index.html` is never cached and fingerprinted assets
  are cached forever. The API trusts exactly one proxy hop for client IPs (rate limits).
- **Secrets never enter an image.** `.dockerignore` excludes every `.env`; settings arrive at run time
  (`env_file`). The one build-time value, Clerk's publishable key, is public by design.
- **The web build needed separating.** At first the API image also required the Clerk key, because both
  went through one build stage. Now the server and web builds are separate stages.

### CI/CD

Every push and pull request runs dependency audit, formatting, lint, type checks, all tests (with a Redis
service container) and the build, then builds both images. On `main` the images are published to GitHub
Container Registry, tagged with the commit SHA (immutable, for rollbacks) and `latest`. A newer push
cancels the run in progress, and permissions are read-only except where publishing needs package writes.
The workflow refuses to publish a web image built with a placeholder key.

### Load testing: what the numbers did and didn't say

The load test runs the **compiled production server** in its own process against real MongoDB and Redis,
with 2,000 users, 100,000 follows and 40,000 posts, and a traffic mix of feeds, profiles, posts, hashtags,
trending and likes. Sign-in is real RS256 verification (Clerk's networkless mode with a generated key).

**First result: about 30 requests per second, flat from 8 to 128 users.** Flat throughput with rising
latency means a shared bottleneck, so I measured each suspect separately:

- Token verification: 0.9 ms per request. Not it.
- MongoDB in Docker Desktop on Windows: 4 ms per round trip from the host, and a hard cap of about 1,400
  simple queries per second even from inside Docker's network (a native MongoDB does tens of thousands).
  The laptop was also on battery, at 59% CPU before the test. **That's the cap, and it's the machine.**

So raw throughput on this laptop says little about the app. What does carry over to any hardware is **how
many round trips each request makes**, because that count multiplies whatever the latency is. The load test
now measures it exactly, scoped to its own databases: the profiler for MongoDB, MONITOR for Redis
(excluding commands inside Lua scripts, which are one round trip).

That measurement found a real inefficiency: **a single post took 12 MongoDB queries, and 4 were
duplicates.** The access check loaded the author and the viewer's relationship to them, then building the
response loaded the same four things again. The same happened on profile post lists. Passing what the check
already loaded into the response builder brought both to 8. A query-budget test now holds them there and
checks that a page of 20 posts costs the same as a page of 1 (no N+1). Reverting the fix fails it at 12.

A first, naive Redis count showed 815 commands per feed read. It was a counting artifact: a timeline
rebuild is one Lua script of up to 800 writes, and Redis counts each command inside the script.
**Interview takeaway: measure what you think you're measuring.** Server-wide counters included the
dev worker's polling and commands inside Lua, and either would have sent the optimisation the wrong way.
