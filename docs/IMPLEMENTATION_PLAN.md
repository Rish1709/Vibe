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
- [ ] Socket.IO handshake authentication (moved to Phase 7, where sockets are introduced)
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
- [ ] Cascade cleanup of a deleted post's likes/comments/bookmarks (Phase 7 background job;
      hydration already hides them)
- [ ] Counter reconciliation job (Phase 7)
- [~] Live click-through with a real account (pending)

Tests: shared 27, API 113, web 27. Mutation-checked: like counting, follow/block race (both
guards), and read-time visibility in hydration.

## Phases 5–10

See the roadmap in `README.md`.
