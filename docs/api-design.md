# API design

A JSON REST API under `/api/v1`, plus a Socket.IO connection for live updates. Request and response
shapes are zod schemas and TypeScript types in `packages/shared`, used by the API and the web app alike.

## Conventions

**Versioning.** Everything is under `/api/v1`. A breaking change would ship as `/api/v2` alongside v1;
additive changes (a new field, a new endpoint) don't need a version.

**Authentication.** Every `/api/v1` route except the Clerk webhook needs `Authorization: Bearer <Clerk
session token>`. The API verifies signature, expiry and the authorized party (`azp`) on every request; no
server-side session. A user signing in for the first time is created on that first request. Routes that
need a username answer `403 ONBOARDING_REQUIRED` until onboarding is done.

**Envelopes.** Success is `{ "data": ..., "meta"?: ... }`; lists put the next cursor in `meta`. Errors are
always:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": { "...": "which fields failed, and why" },
    "requestId": "9313c3ef-..."
  }
}
```

Clients branch on `code` (a fixed list in `packages/shared/src/errors.ts`), never on `message`.
`requestId` is also returned as `X-Request-Id` and appears on the server's log line for that request.

| Status  | Codes                                                                  |
| ------- | ---------------------------------------------------------------------- |
| 400     | `BAD_REQUEST`, `VALIDATION_ERROR`                                      |
| 401     | `UNAUTHENTICATED`                                                      |
| 403     | `FORBIDDEN`, `ONBOARDING_REQUIRED`, `ACCOUNT_DELETED`                  |
| 404     | `NOT_FOUND` (also for things you may not know exist, see below)        |
| 409     | `CONFLICT`, `USERNAME_TAKEN`                                           |
| 413/415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`                          |
| 429     | `RATE_LIMITED` (with `Retry-After`)                                    |
| 503     | `REQUEST_TIMEOUT`, `SERVICE_UNAVAILABLE`                               |
| 500     | `INTERNAL_ERROR` (logged with the stack; the client sees no internals) |

**404 versus 403.** If the caller isn't allowed to know something exists (a blocked user's profile,
someone else's conversation, a post you can't see), the answer is 404, the same as if it didn't exist.
403 is for things whose existence is already public: a private account's profile is visible, its posts
are `403 FORBIDDEN` until you're an approved follower.

**Validation.** Params, query and body are parsed by zod schemas before the handler runs; bodies are
`.strict()`, so an unexpected field is a 400 rather than silently ignored (no mass assignment). Express
parses query strings flatly, so `?q[$gt]=` can't become an operator.

**Pagination.** Cursor-based: `?limit=20&cursor=<opaque>` (max 50), with `meta.nextCursor` null on the
last page. Cursors encode the last row's sort key, so pages stay correct while rows are inserted, and
every page costs the same.

**Idempotency.** Toggles are `PUT` (on) and `DELETE` (off): repeating one is harmless, so the browser can
retry freely and a double-tap can't double-count. Message sends carry a client-generated `clientId`; a
retried send returns the original message instead of posting it twice.

**Rate limits.** Sliding window in Redis, per IP before authentication (600/min) and per user after
(300/min), plus stricter per-action limits, for example posts 30/min, comments 30/min, likes and other
toggles 120/min, follows and blocks 60/min, messages 60/min, search 120/min, uploads 30/min. Every
response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining`.

**Timeouts.** Each request gets 15 s, then a `503 REQUEST_TIMEOUT`. The web client gives up after 20 s
(longer, so the server's answer arrives first).

## Endpoints

### Account and profiles

| Method | Path                                     | Notes                                      |
| ------ | ---------------------------------------- | ------------------------------------------ |
| GET    | `/users/me`                              | The signed-in user (created on first call) |
| POST   | `/users/me/onboarding`                   | Choose username and display name           |
| GET    | `/users/username-availability?username=` | For the onboarding form                    |
| PATCH  | `/users/me`                              | Display name, bio, website, avatar         |
| PATCH  | `/users/me/settings`                     | Private account, who can message you       |
| GET    | `/users/:username`                       | Profile with the viewer's relationship     |

### Social graph

| Method     | Path                                           | Notes                                                    |
| ---------- | ---------------------------------------------- | -------------------------------------------------------- |
| PUT/DELETE | `/users/:id/follow`                            | Follow (a request, if the account is private) / unfollow |
| DELETE     | `/users/:id/follower`                          | Remove someone who follows you                           |
| GET        | `/users/:id/followers`, `/users/:id/following` | Paged                                                    |
| GET        | `/users/me/follow-requests`                    | Pending requests to you                                  |
| POST       | `/users/me/follow-requests/:id/accept`         |                                                          |
| DELETE     | `/users/me/follow-requests/:id`                | Decline                                                  |
| PUT/DELETE | `/users/:id/block`; GET `/users/me/blocks`     | Blocking removes follows both ways                       |

### Posts, engagement, comments

| Method     | Path                                      | Notes                                                                     |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| POST       | `/posts`                                  | Text, up to 4 photos or 1 video (`mediaIds`), or a quote (`quotedPostId`) |
| GET        | `/posts/:id`                              |                                                                           |
| PATCH      | `/posts/:id`                              | Edit text (author only); marked "edited"                                  |
| DELETE     | `/posts/:id`                              | Soft delete; dependents purged in the background                          |
| PUT/DELETE | `/posts/:id/like`, `/bookmark`, `/repost` | Toggles; return the new state and count                                   |
| GET        | `/posts/:id/likes`                        | Who liked it                                                              |
| GET/POST   | `/posts/:id/comments`                     | Top-level comments; POST with `parentId` replies                          |
| GET        | `/comments/:id/replies`                   |                                                                           |
| DELETE     | `/comments/:id`                           | Author of the comment or of the post                                      |
| GET        | `/users/:id/posts`, `/users/me/bookmarks` |                                                                           |
| GET        | `/feed`                                   | Home feed (header `X-Feed-Source` says how it was served)                 |

### Media and stories

| Method | Path                          | Notes                                                         |
| ------ | ----------------------------- | ------------------------------------------------------------- |
| POST   | `/media/uploads`              | Get a signed ticket: the browser uploads straight to ImageKit |
| POST   | `/media/uploads/:id/complete` | API verifies the stored file against the ticket               |
| POST   | `/stories`                    | From an uploaded story image or video                         |
| GET    | `/stories/tray`               | Followed accounts with active stories, unseen first           |
| GET    | `/users/:id/stories`          |                                                               |
| POST   | `/stories/:id/views`          | Idempotent                                                    |
| GET    | `/stories/:id/viewers`        | Author only                                                   |
| DELETE | `/stories/:id`                |                                                               |

### Messages and notifications

| Method | Path                           | Notes                                           |
| ------ | ------------------------------ | ----------------------------------------------- |
| GET    | `/conversations`               | Inbox, most recent first, with unread counts    |
| POST   | `/conversations`               | Open (or return) the conversation with `userId` |
| GET    | `/conversations/:id`           |                                                 |
| GET    | `/conversations/:id/messages`  | Newest first, paged                             |
| POST   | `/conversations/:id/messages`  | `{ text, clientId }`                            |
| POST   | `/conversations/:id/read`      |                                                 |
| GET    | `/notifications`               |                                                 |
| GET    | `/notifications/unread-counts` | Notifications and messages, for the badges      |
| POST   | `/notifications/read`          | Mark all read                                   |

### Search and discovery

| Method | Path                   | Notes                                                     |
| ------ | ---------------------- | --------------------------------------------------------- |
| GET    | `/search/users?q=`     | Name or username prefix                                   |
| GET    | `/search/posts?q=`     | Every word must appear; a lone `#tag` is a hashtag lookup |
| GET    | `/hashtags/:tag/posts` |                                                           |
| GET    | `/explore/trending`    | Top hashtags of the last 7 days by distinct authors       |
| GET    | `/explore/suggestions` | Who to follow                                             |

### Operations

| Method | Path                     | Notes                                                                  |
| ------ | ------------------------ | ---------------------------------------------------------------------- |
| GET    | `/health/live`           | The process is up (restart it if not)                                  |
| GET    | `/health/ready`          | MongoDB and Redis reachable and not shutting down (route traffic here) |
| POST   | `/api/v1/webhooks/clerk` | Signed by Clerk (Svix); keeps deletions in sync                        |

## Realtime (Socket.IO)

The client connects to `/socket.io` (WebSocket only) with the Clerk token in the handshake. Each socket
joins a room named after its user, so any API instance or the worker can reach a user wherever they're
connected (Redis adapter). Events are typed in `packages/shared/src/realtime.ts`:

- server → client: `message:new`, `conversation:read` (read receipts), `typing`, `notification:new`,
  `notification:count` (badge updates)
- client → server: `typing` (throttled; ignored unless the sender is in the conversation)

Sends go over REST, not the socket: one code path for validation, rate limits, idempotency and errors,
and a send works even while the socket is reconnecting. After a reconnect, the client refetches what it
may have missed instead of relying on event replay.
