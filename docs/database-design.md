# Database design

MongoDB (a replica set, even locally, because transactions require one) is the source of truth. Redis
holds only data that can be rebuilt from it ([caching-strategy.md](caching-strategy.md)).

## Principles

1. **Relationships are documents, not arrays.** A follow, like, bookmark or block is its own small
   document with a unique index on the pair. Arrays inside a user (`followers: [...]`) would grow without
   bound toward MongoDB's 16 MB document limit, rewrite a large document on every follow, and can't be
   paginated by index.
2. **Every list query has an index that serves it in order.** The pattern is ESR: **e**quality fields
   first, then the **s**ort fields, then **r**ange fields. Lists end in `createdAt, _id` because `_id`
   breaks ties for keyset pagination. A test (`queryPlans.test.ts`) runs the app under MongoDB's profiler
   and fails on any collection scan or in-memory sort outside documented exceptions.
3. **Keyset pagination, never `skip`.** The cursor is the last row's `(createdAt, _id)`; the next page
   is `createdAt < c OR (createdAt = c AND _id < id)`. Cost is O(log n + page) at any depth, and rows
   inserted meanwhile don't shift pages.
4. **Counters are denormalized** (`counts.likes` on a post, `counts.followers` on a user) so a page
   doesn't count rows. They're updated with `$inc` only when the edge write actually changed something
   (a duplicate like changes nothing), and a daily job re-counts and repairs drift.
5. **Soft delete where others point at you** (`deletedAt` on users, posts, comments): references stay
   valid, readers filter `deletedAt: null`, and a background cascade purges the dependents in batches.
6. **Expiry in queries, TTL indexes for garbage collection.** Stories filter `expiresAt > now` in every
   query; the TTL index deletes them later (MongoDB's TTL monitor runs about once a minute, so it isn't
   precise enough to enforce "24 hours").

## Collections

| Collection      | One document per                | Key fields                                                                                                                                               |
| --------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`         | account                         | `clerkId`, `username` (set at onboarding), `displayName`, `searchTokens`, `isPrivate`, `messagePolicy`, `counts{followers,following,posts}`, `deletedAt` |
| `follows`       | follower → followee edge        | `status: pending \| active` (pending = a request to a private account)                                                                                   |
| `blocks`        | blocker → blocked edge          |                                                                                                                                                          |
| `posts`         | original, quote or plain repost | `kind`, `text`, `hashtags[]`, `media[]` (embedded), `sharedPostId`, `counts{likes,comments,reposts}`, `fanoutSkipped`, `editedAt`, `deletedAt`           |
| `comments`      | comment or reply                | `postId`, `parentId` (null = top level; replies are flattened to one level)                                                                              |
| `likes`         | user × post                     |                                                                                                                                                          |
| `bookmarks`     | user × post                     |                                                                                                                                                          |
| `media`         | uploaded file                   | `ownerId`, `purpose` (post, story, avatar), `status` (pending → ready → attached), `fileId`                                                              |
| `stories`       | story                           | `media` (embedded), `caption`, `expiresAt`, `viewCount`                                                                                                  |
| `storyviews`    | viewer × story                  | `expiresAt` (copied, for its own TTL)                                                                                                                    |
| `conversations` | pair of users                   | `key` (sorted ids), `participants[]`, `members[{userId, unread, lastReadAt}]`, `lastMessage`, `lastMessageAt`                                            |
| `messages`      | message                         | `conversationId`, `senderId`, `text`, `clientId` (idempotency)                                                                                           |
| `notifications` | recipient × event               | `type`, `actorId`, `postId`, `commentId`, `dedupeKey`, `readAt`; expires after 90 days                                                                   |

**Embedded vs referenced.** Media metadata is embedded in posts and stories (read together, written
once, at most four items); the `media` collection separately tracks ownership and lifecycle. Conversation
members are embedded (always exactly two). Everything that grows without bound is its own collection.

## Indexes and the query each one serves

| Collection    | Index                                                                                 | Serves                                                   |
| ------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| users         | `{clerkId}` unique                                                                    | authentication: token subject → user                     |
| users         | `{username}` unique, sparse                                                           | profile URLs; uniqueness (absent until onboarding)       |
| users         | `{searchTokens}` (multikey)                                                           | name search by word prefix ("hop" → Grace Hopper)        |
| users         | `{counts.followers: -1, _id}` partial (not deleted, onboarded)                        | who-to-follow fallback: popular accounts                 |
| follows       | `{followerId, followeeId}` unique                                                     | one edge per pair; "do I follow them?"                   |
| follows       | `{followeeId, status, createdAt, _id}`                                                | followers list; pending requests                         |
| follows       | `{followerId, status, createdAt, _id}`                                                | following list; feed and suggestion seeds                |
| blocks        | `{blockerId, blockedId}` unique + reverse                                             | block checks in both directions                          |
| posts         | `{authorId, createdAt, _id}`                                                          | profile posts; per-author ranges merged into feeds       |
| posts         | `{fanoutSkipped, authorId, createdAt, _id}` partial                                   | celebrity posts merged at read time (holds only those)   |
| posts         | `{hashtags, createdAt, _id}`                                                          | hashtag pages                                            |
| posts         | `{authorId, sharedPostId}` unique, partial (reposts)                                  | one plain repost per user per post                       |
| posts         | `{sharedPostId, kind}`                                                                | "did I repost these?", repost cascades                   |
| posts         | text `post_text` (language `none`)                                                    | post search                                              |
| comments      | `{postId, parentId, createdAt, _id}`                                                  | a post's top-level comments                              |
| comments      | `{parentId, createdAt, _id}`                                                          | a comment's replies, oldest first                        |
| likes         | `{postId, userId}` unique                                                             | one like per user; "did I like these?" as point lookups  |
| likes         | `{postId, createdAt, _id}`                                                            | "liked by" list                                          |
| bookmarks     | `{userId, postId}` unique; `{userId, createdAt, _id}`; `{postId}`                     | saved list; cleanup when a post is deleted               |
| media         | `{fileId}` unique, sparse; `{status, createdAt}`; `{purpose, status, attachedAt}`     | verification; cleanup of abandoned uploads               |
| stories       | `{authorId, expiresAt, _id}`; `{expiresAt}` TTL                                       | tray and profile stories in playback order; expiry       |
| storyviews    | `{storyId, viewerId}` unique; `{storyId, createdAt, _id}`; `{viewerId, storyId}`; TTL | seen-once; viewers list; "seen" rings                    |
| conversations | `{key}` unique                                                                        | one conversation per pair, even under concurrent creates |
| conversations | `{participants, lastMessageAt, _id}`                                                  | the inbox, most recent first                             |
| conversations | `{members.userId, members.unread}`                                                    | unread badge                                             |
| messages      | `{conversationId, createdAt, _id}`                                                    | message history                                          |
| messages      | `{senderId, clientId}` unique                                                         | idempotent send: a retried request returns the original  |
| notifications | `{recipientId, dedupeKey}` unique                                                     | like → unlike → like notifies once                       |
| notifications | `{recipientId, createdAt, _id}`; `{recipientId, readAt}`                              | the list; unread count                                   |
| notifications | `{postId}`, `{commentId}` partial; `{createdAt}` TTL 90 d                             | cleanup when the target is deleted; expiry               |

Indexes are declared on the Mongoose schemas and applied with `npm run db:sync-indexes -w @vibe/api`,
which also drops indexes no longer declared. Production runs with `autoIndex` off, so index builds are
an explicit deploy step rather than a side effect of the first request.

## Concurrency

- **Uniqueness is enforced by indexes, not by "check then insert".** Two simultaneous follows, likes,
  conversation creations or first sign-ins race to insert; one wins, the other hits the unique index and
  is treated as "already done".
- **Conditional updates instead of locks.** Soft delete is `updateOne({_id, deletedAt: null}, ...)`, so a
  double delete changes (and decrements counters) once. The inbox preview updates only if the message is
  newer than the stored one.
- **Transactions are used sparingly** (blocking: insert the block, remove edges, fix counters). They
  exposed one real bug: a concurrent follow could slip in, because inside the transaction the block is
  invisible until commit and the edge delete reads a snapshot from before the follow existed. The fix is a
  non-transactional sweep of the pair's edges _after_ commit; a stress test of 30 races per run catches
  its removal. Transactions give atomicity and a snapshot, not linearizability against outside writers.
  See INTERVIEW_NOTES, "snapshot isolation broke the follow/block race argument".

## Growth path

What changes as the data grows is in [scalability.md](scalability.md): read replicas for read-heavy
lists, sharding keys per collection (`authorId` for posts, `conversationId` for messages,
`recipientId` for notifications), and moving search to a dedicated engine.
