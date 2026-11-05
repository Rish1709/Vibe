# Engineering decisions

Each entry: the decision, what else was considered, why, and what it costs. Short on purpose; the
measurements and bugs behind them are in [`INTERVIEW_NOTES.md`](../INTERVIEW_NOTES.md).

### 1. A modular monolith, not microservices

**Chosen:** one API codebase split into feature modules (`users`, `posts`, `feed`, `messages`...), plus a
worker process built from the same code. **Considered:** a service per feature. **Why:** one team and one
database; microservices would add network hops, distributed transactions and deployment overhead with no
independent scaling need yet. Module boundaries (routes → service → model, no reaching into another
module's collections except through its service or the shared policy) keep a later split possible.
**Cost:** one deploy unit; a bad deploy affects every feature.

### 2. Shared zod contracts in `packages/shared`

**Chosen:** request schemas and response types defined once, imported by API and web. **Considered:**
OpenAPI with code generation, GraphQL. **Why:** compile-time agreement with no generator step, and the web
forms validate with the exact schema the API enforces. **Cost:** TypeScript-only clients; a public API
would still want an OpenAPI document.

### 3. MongoDB as the source of truth

**Chosen:** MongoDB replica set. **Considered:** PostgreSQL. **Why:** posts, stories and conversations are
read as whole documents with embedded media and counters; flexible schema suited a fast-moving product;
replica sets give transactions where needed. **Cost:** no joins (solved with batch hydration: one query per
related collection per page), no foreign keys (solved with soft delete, background cascades and a daily
counter reconciliation), and graph queries (friends of friends) are aggregations rather than SQL.
PostgreSQL would have been an equally defensible choice.

### 4. Edges as documents, uniqueness by index

Follows, likes, bookmarks, blocks and story views are one small document per pair with a unique index.
Arrays on the user document were rejected: unbounded growth, rewrite amplification, no index pagination.
Races (double-tap, two tabs) resolve at the unique index instead of with locks.

### 5. Clerk for identity, local users for everything else

**Chosen:** Clerk handles passwords, sessions, MFA and social login; the API verifies its JWTs on every
request and keeps its own `users` collection. **Considered:** own auth (bcrypt + sessions), Auth0.
**Why:** authentication is high-risk to build and not the point of the product. Users are created lazily on
their first request (no dependency on webhook delivery for sign-up), and the webhook only syncs deletions.
Verification needs no Clerk round-trip per request: Clerk's public keys (JWKS) are fetched once and
cached, or supplied up front as a PEM key (`CLERK_JWT_KEY`). **Cost:** a vendor
dependency on sign-in.

### 6. Hybrid feed: fan-out on write, except for very popular authors

**Chosen:** a post is pushed onto each follower's Redis timeline by a background job; authors above a
follower threshold are skipped and merged in at read time. The decision is stored on the post, so a later
follower-count change can't make a post appear twice or vanish. **Considered:** pure pull (query followees'
posts on read: slow for users following many accounts), pure push (one celebrity post = millions of
writes). **Cost:** two code paths and a slightly stale feed (seconds) after a follow. Details and
measurements: [caching-strategy.md](caching-strategy.md).

### 7. Redis is a cache, never the only copy

Timelines, auth lookups, trending and suggestions are rebuilt from MongoDB on a miss. Keys are versioned
(`v1:`), cached JSON is re-validated with zod on read (a bad entry is a miss, not a crash), TTLs are
jittered to avoid stampedes. **Cost:** cold reads after a Redis loss are slower, never wrong.

### 8. Side effects through a queue (BullMQ)

Feed fan-out, notifications, post cascades and cleanups run in the worker. The request path only enqueues,
and a queue failure is logged rather than failing a write that already happened. **Considered:** doing it
inline (slow requests, a celebrity post would time out), Kafka (more than this scale needs). **Cost:**
eventual consistency, and jobs must be idempotent because they can run twice. They are: dedupe keys,
conditional updates, "insert then re-check" for undo races.

### 9. Keyset pagination everywhere

`createdAt, _id` cursors instead of `skip/offset`: constant cost at any depth and stable while new rows
arrive. **Cost:** no "jump to page 7", which a feed never needs.

### 10. Uploads go straight from the browser to the CDN

The API signs a ticket (folder, name, type, size) and later verifies the stored file against it; it never
handles file bytes. **Considered:** uploading through the API (bandwidth and memory on every instance).
**Cost:** a verification step, and abandoned uploads that a scheduled job deletes.

### 11. REST for writes, Socket.IO only to push

Sending a message is a REST call with a client id (idempotent, rate-limited, validated like everything
else); the socket only delivers events. After a reconnect the client refetches. **Considered:** sending over
the socket (a second validation and error path, lost sends during reconnects), server-sent events (no
client → server channel for typing). **Cost:** one extra HTTP request per send.

### 12. Search on MongoDB `$text` (for now)

**Chosen:** a text index with language `none` (English mode was measured and dropped stop words, so "the
park" found nothing); word-prefix tokens for people search. **Considered:** Elasticsearch/OpenSearch, Atlas
Search. **Why:** no extra system to run at this size. **Cost:** no relevance ranking, typo tolerance or
stemming, and newest-first needs an in-memory sort of all matches. The upgrade path is a search engine fed
by change streams.

### 13. Tests against real databases; fakes only at the edges

Integration tests run the real Express app against an in-memory MongoDB **replica set** and a real Redis.
Only external services (Clerk, ImageKit) are replaced, with fakes that implement the same interface and can
misbehave on purpose. Key guards are **mutation-checked**: remove the guard, watch the test fail, restore
it. Cross-cutting tests guard whole classes of bugs: an authorization matrix over every route, and a
profiler-based check that every query uses an index. **Cost:** slower than mocked unit tests, but worth
it: mocks would have hidden most of the bugs listed in the notes.

### 14. One image for API and worker; nginx in front

The API and worker share an image (two entry points), so they can't disagree about models or job formats.
nginx serves the built web app and proxies `/api` and `/socket.io`, so the browser talks to one origin (no
CORS preflights). Containers run as non-root; secrets are passed at run time, never built into images.

### Deliberately not done

- **GraphQL:** the screens map cleanly to resources, and REST keeps caching and rate limiting simple.
- **Kubernetes manifests:** compose describes the topology; the images are orchestrator-agnostic.
- **Server-side rendering:** an authenticated app with no SEO surface; a static SPA on a CDN is simpler.
- **Feed ranking by engagement:** the ranker is pluggable, but chronological is honest and predictable
  without real usage data to tune against.
