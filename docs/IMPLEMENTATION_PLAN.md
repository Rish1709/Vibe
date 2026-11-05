# Implementation checklist

Status legend: `[x]` done and tested · `[~]` written, not yet verified · `[ ]` not started.

## Phase 1: Planning

- [x] Repository inspection (empty repo, Node 22.17, npm, Docker)
- [x] Architecture, schema, API surface, roadmap, risks, dependencies (agreed in chat)

## Phase 2: Foundation

- [x] npm workspaces: `packages/shared`, `apps/api`, `apps/web`
- [x] Strict TypeScript 6 base config, ESLint 10 (type-checked rules), Prettier
- [x] Shared package: error codes, response envelope types, pagination and ObjectId schemas
- [x] Zod-validated environment config (fails fast, never echoes values)
- [x] Structured logging (pino, redaction, request ids honouring upstream `X-Request-Id`)
- [x] Centralized error handler and consistent response envelope
- [x] `validated()` handler wrapper: typed params/query/body, all issues reported at once
- [x] Request timeout middleware
- [x] Cursor encode/decode and `limit + 1` page builder
- [x] Health endpoints: `/health/live`, `/health/ready` (per-check timeouts, drain-aware)
- [x] MongoDB connection (pooling, fail-fast server selection) and Redis client factory
- [x] Graceful shutdown (drain HTTP, then Redis, then Mongo; watchdog timeout)
- [x] Web shell: Vite 8, Tailwind 4 tokens (light/dark), React Router, TanStack Query, toasts
- [x] Typed fetch client normalizing every failure into `ApiError`
- [x] Docker Compose: MongoDB 8 single-node replica set + Redis 8 (`noeviction`)
- [x] Verified against real infra: readiness 200 → 503 when Redis stops → 200 when it returns

Tests: shared 11, API 32, web 7. All passing.

## Phase 3: Authentication and users

- [x] Clerk session-token verification (HTTP) behind a `TokenVerifier` interface; `azp` enforced
- [x] Socket.IO handshake authentication (Phase 7)
- [x] Lazy user provisioning on first request (race-safe via unique index on `clerkId`)
- [x] Clerk webhook sync: signature + replay check, out-of-order guard, tombstones on delete
- [x] Auth-user cache in Redis (cache-aside, jittered TTL, invalidation on rename/delete, fails open)
- [x] Onboarding / username claim (partial unique index, one-shot transition, reserved names)
- [x] Profile read/edit, privacy and message-policy settings
- [x] Redis sliding-window-counter rate limiter (Lua, atomic, Redis clock, EVALSHA + NOSCRIPT fallback)
- [x] Frontend: Clerk sign-in/up, route guards, onboarding with debounced availability,
      profile page, settings (dirty-field PATCH, optimistic privacy toggle with rollback)
- [x] Live end-to-end: real Clerk sign-in → provisioning → onboarding → profile → settings, no server errors

Tests: shared 27, API 81, web 18. All passing. Webhook-ordering and one-shot-onboarding tests
were mutation-checked (each fails when its guard is removed).

## Phase 4: Social graph and content

- [x] Follows with private-account requests (accept, decline, remove follower), idempotent toggles
- [x] Blocks: transaction plus post-commit sweep; blocked users vanish (404) for the blocked side
- [x] Single visibility policy (`policies/visibility.ts`) used by every read and write
- [x] Batch relationship lookup (3 queries for any number of accounts) and post hydration (~8 queries
      per page, independent of page size)
- [x] Posts: create, edit, soft delete, hashtags, quotes, one-per-user reposts (partial unique index)
- [x] Likes and bookmarks: upsert-then-count, race-safe without transactions
- [x] Comments: two-level threads, newest-first top level, oldest-first replies, author/owner delete
- [x] Keyset pagination helper on (createdAt, \_id) for every list
- [x] Seed script (deterministic, re-runnable, counters derived from edges, `--connect <username>`)
- [x] `db:sync-indexes` script; username index changed from partial to sparse after `explain()`
      showed every profile lookup was a COLLSCAN
- [x] Frontend: composer, post card (optimistic like/bookmark/repost with rollback), quotes,
      post detail with comments, follow button, followers/following lists, bookmarks, follow
      requests and blocked accounts in settings, infinite scroll
- [x] Cascade cleanup of a deleted post's likes/comments/bookmarks (Phase 7)
- [x] Counter reconciliation job (Phase 7)
- [~] Live click-through with a real account (pending)

Tests: shared 27, API 113, web 27. Mutation-checked: like counting, follow/block race (both
guards), and read-time visibility in hydration.

## Phase 5: Home feed

- [x] Hybrid fan-out: push to Redis timelines for ordinary authors, pull for celebrity posts
      (`fanoutSkipped` flag + partial index), merged by one `(createdAt, _id)` cursor
- [x] BullMQ fan-out queue (deterministic job ids, retries with backoff) and a separate worker process
- [x] Timeline store: capped sorted sets of ids, lazy creation, TTL, conditional writes in Lua
- [x] Rebuild on demand with stampede lock, mid-rebuild publish capture, version-checked commit,
      crash-safe placeholder, permanent anchor against empty-set deletion
- [x] Invalidation on follow / unfollow / accept / remove follower / block
- [x] Read-your-writes for the author; seamless continuation from MongoDB past the cap
- [x] Redis outage: feed served from MongoDB (tested against a dead Redis)
- [x] Frontend home feed with infinite scroll; composer refreshes it
- [x] Benchmark script with measured numbers (`npm run bench:feed -w @vibe/api`)
- [ ] Transactional outbox for publish events (documented upgrade path)

Mutation-checked: job id format, rebuild placeholder, rebuild version check, celebrity flag, rebuild lock.

## Phase 6: Stories and media

- [x] Direct-to-ImageKit uploads with server-signed credentials (HMAC-SHA1, no SDK)
- [x] Post-upload verification against ImageKit's record: name, folder, MIME, kind, size
- [x] Media lifecycle (pending → ready → attached → released) with atomic single-use claiming
- [x] Photo and video posts (up to 4 photos or 1 video, text optional), avatars
- [x] Stories: 24h expiry enforced in queries (TTL is cleanup only), tray, unseen rings, deduped views,
      author-only viewer list, delete
- [x] Hourly media cleanup job (BullMQ job scheduler in the worker)
- [x] Frontend: composer media picker with progress, responsive ImageKit delivery, story tray and
      full-screen viewer (Zustand), avatar picker
- [x] Live upload through real ImageKit: photo post and story verified end to end
- [x] Fixed from live testing: pre-Phase-6 posts (no `media` field) crashed the feed; a slow ImageKit
      lookup surfaced as a 500 (now retried once, then a 503 the browser retries)
- [x] `db:sync-indexes` now includes the media and story models

Tests: shared 27, API 162, web 33. Mutation-checked: story expiry, view dedup, upload folder check,
atomic claim.

## User search (pulled forward from Phase 8)

- [x] `GET /search/users`: username prefix + display-name word prefix, accent-insensitive, both index scans
- [x] `searchTokens` written with every display-name change; idempotent backfill (`db:backfill-search`)
- [x] Private accounts findable and flagged; blocked accounts (either way) excluded; regex-escaped
- [x] Search page: debounced, query in the URL, follow / request / cancel from results
- [ ] Live check in the browser

## Phase 7: Real-time messaging and notifications

- [x] Socket.IO on every API instance with the Redis adapter; the worker publishes via the Redis emitter
- [x] Handshake auth with the same Clerk verification as REST; coded rejections; deletion disconnects
- [x] Direct messages: race-safe get-or-create, idempotent sends (clientId), exact unread counts under
      concurrency, conditional inbox preview, read receipts, typing relay (members only, throttled)
- [x] Message policy ("everyone" / "following") with the reply exception; blocks both ways
- [x] Notifications for likes, comments, replies, follows, requests and accepts: BullMQ worker, dedupe
      key, "insert, then check" against undo races, live unread count, read-time visibility
- [x] Post cascade job (batched, idempotent) and daily counter reconciliation (quiet-counter rule)
- [x] Frontend: inbox, conversation (optimistic send with retry, typing, Seen), notifications page,
      nav badges, Message button on profiles, refetch after reconnect
- [ ] Live check in the browser with two accounts

Mutation-checked: the notification re-check after insert, the reconciler's quiet rule, side-effect-free
send retries.

## Phase 8: Search and discovery

- [x] Post search: `$text` with every word required, operator-safe input, keyset by recency; index
      language chosen by measurement ("none": English mode broke "the park")
- [x] Hashtag pages on the existing { hashtags, createdAt, _id } index; hashtags and mentions linked
- [x] Trending hashtags: distinct-author ranking, private accounts excluded, `_id`-range window,
      5-minute cache
- [x] Who to follow: friends of friends (bounded seed), popular-account fallback (partial index),
      cached candidates filtered live
- [x] Frontend: Explore page, People / Posts search tabs, hashtag page
- [x] Live check in the browser

User search was pulled forward into Phase 6. Mutation-checked: trending's author ranking and privacy filter.

## Phase 9: Testing, performance and security review

- [x] Authorization matrix: every read and write route tried by a stranger and a blocked account
      against a private account's data; positive control; database checked afterwards
- [x] Side doors covered: replies via another post, quotes, someone else's upload, follow requests
- [x] Dependency audit: 0 production vulnerabilities; dev-only eslint finding recorded
- [x] Query-plan test: profiler over a tour of the app, no COLLSCAN or in-memory sort outside
      documented exceptions
- [x] Fixed: stories sorted in memory (index now `{authorId, expiresAt, _id}`)
- [x] Fixed: requests that could hang forever (offline pause, no deadline on token or fetch)
- [x] Load testing: done in Phase 10 (below)

Mutation-checked: three authorization guards (edit ownership, reply parent, media owner), the story
sort, and the client deadline.

## Phase 10: Docker, CI/CD, documentation

- [x] Multi-stage `Dockerfile`: API/worker image (production dependencies only, non-root, health check)
      and web image (unprivileged nginx serving the build, proxying `/api` and `/socket.io`)
- [x] `npm run stack:up` / `stack:down`: the production build of the whole app in compose, verified
      (health, SPA routes, security headers, API through the proxy, JSON logs, worker consuming)
- [x] GitHub Actions: audit, format, lint, types, tests (Redis service), build, both images; publish to
      GHCR from `main` (refuses to publish a web image without the real Clerk key)
- [x] Load test of the production server build (`npm run load-test -w @vibe/api`): throughput and
      latency by concurrency, plus database round trips per request
- [x] Fixed from the load test: post and profile pages re-read what their access check had loaded
      (12 → 8 queries); a query-budget test guards it, including no N+1 across page sizes
- [x] Docs: architecture, database design, API design, scalability, engineering decisions
- [ ] CI run on GitHub: needs a repository (the workflow parses, but hasn't run)

Mutation-checked: the query budget (reverting the reuse fails it).
