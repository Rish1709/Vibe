# Vibe: Central Visibility Policy — Interview Study Guide

Nov 20, 2026 · @Rishabh

## TL;DR

Vibe keeps every "who may see or do what" rule in one file, `apps/api/src/policies/visibility.ts`. It holds six small **pure functions** that take already-loaded data and return `true` or `false`. No module writes its own privacy or block logic. Each one calls these functions.

Every module follows the same four steps:

1. **Load** the target (user, post, story, conversation).
2. **Describe the relationship** between the viewer and the target's owner as a `Relationship` object (follow state plus blocks in both directions).
3. **Ask the policy**, for example `canViewContent(rel, author)`, and get a boolean back.
4. **Translate** "no" into the right HTTP response (404 or 403), or use the boolean as a UI flag or a list filter.

> **One-line pitch for interviews:** "Authorization rules are pure functions over a precomputed relationship, so they're centralized, unit-testable and cost zero queries. The service layer owns I/O and error mapping."

&#91;embedded content: visibility flow · callers, 3 steps\]

The policy in the middle is the only place rules live. Steps 1 and 3 belong to each module.

## Why centralize it

Centralizing stops privacy rules from drifting apart as features are added. Without it, profiles, posts, comments, stories, search and chat would each re-implement "private account" and "blocked" checks. Sooner or later one of them gets it wrong and leaks content.

| Benefit                     | What it means in this codebase                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Single source of truth      | Changing a rule (say, letting pending followers see stories) is one edit in `visibility.ts`, and every endpoint follows.    |
| Pure, so trivially testable | No mocks or database needed. Pass a `Relationship` literal and assert the boolean.                                          |
| Zero queries                | The functions never touch the database. Callers load data once, so list endpoints stay free of N+1 lookups.                 |
| Separation of concerns      | The policy answers _whether_. The service decides _how to respond_ (404, 403 or a UI flag).                                 |
| Backend and UI agree        | The same functions produce flags like `canReshare` and `canMessage`, so the frontend only offers actions that will succeed. |

**Mental model:** the policy is the _rulebook_, `Relationship` is the _evidence_, and each service is the _judge_ that announces the verdict in its own words.

## The input: Relationship

Every policy decision is computed from one object that describes how the viewer relates to one other account. It is defined in `apps/api/src/modules/relationships/relationship.service.ts`.

```ts
export interface Relationship {
  isSelf: boolean; // viewer is looking at their own account
  following: FollowState; // 'none' | 'pending' | 'active'  (viewer → them)
  followedBy: boolean; // they actively follow the viewer   (them → viewer)
  blockedByViewer: boolean; // the viewer blocked them
  blockingViewer: boolean; // they blocked the viewer
}
```

**Easy-to-mix-up names:** `blockedByViewer` means _I blocked you_. `blockingViewer` means _you blocked me_. Read them as "from the viewer's point of view".

### How it is loaded without N+1 queries

`getRelationships(viewerId, targetIds)` resolves **any number** of accounts in **3 indexed queries total**, run in parallel with `Promise.all`:

| Query                                                         | Collection    | Fills                               |
| ------------------------------------------------------------- | ------------- | ----------------------------------- |
| Blocks in either direction between the viewer and the targets | `BlockModel`  | `blockedByViewer`, `blockingViewer` |
| Viewer's outgoing follows to the targets                      | `FollowModel` | `following` (with status)           |
| Targets' active follows to the viewer                         | `FollowModel` | `followedBy`                        |

It returns a `Map<targetId, Relationship>`. The viewer's own id is pre-filled with a constant `SELF` entry, so self-checks need no query. Every requested id gets an entry, even with no follow or block rows (all `false` / `'none'`).

`getRelationship(viewerId, id)` is just the single-id wrapper around the batch version.

**Why this matters:** a feed of 20 posts by 15 authors costs 3 queries, not 45. List endpoints then filter in memory with `map.get(authorId)`.

## The policy functions

The whole policy is six exports in `apps/api/src/policies/visibility.ts`. None of them is `async`, and none touches the database.

```ts
// They blocked you → they vanish. You can still open someone YOU blocked (to unblock).
export function canSeeProfile(rel: Relationship): boolean {
  return rel.isSelf || !rel.blockingViewer;
}

// Posts, comments, stories, follower lists.
export function canViewContent(rel: Relationship, author: Author): boolean {
  if (rel.isSelf) return true;
  if (rel.blockingViewer || rel.blockedByViewer) return false;
  return !author.isPrivate || rel.following === 'active';
}

// Like / comment / bookmark = same rule as viewing.
export const canInteract = canViewContent;

// Reshare also needs a PUBLIC author.
export function canReshare(rel: Relationship, author: Author): boolean {
  return canViewContent(rel, author) && !author.isPrivate;
}

// No follow across a block (either way) or of yourself.
export function canFollow(rel: Relationship): boolean {
  return !rel.isSelf && !rel.blockingViewer && !rel.blockedByViewer;
}

// DM rules: no block either way; then the recipient's setting decides.
export function canMessage(rel, recipient, { recipientWroteFirst = false } = {}) {
  if (rel.isSelf || rel.blockedByViewer || rel.blockingViewer) return false;
  return recipient.messagePolicy === 'everyone' || rel.followedBy || recipientWroteFirst;
}
```

### Each rule in plain English

| Function         | Allowed when                                                                                                                       | Why the rule exists                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `canSeeProfile`  | It's you, or they haven't blocked you                                                                                              | A block is hidden: the blocker looks like a deleted account. You can still visit someone you blocked so you can unblock them. |
| `canViewContent` | It's you; or there's no block either way **and** (the account is public **or** you're an _approved_ follower)                      | A pending follow request does not grant access.                                                                               |
| `canInteract`    | Same as `canViewContent`                                                                                                           | You can't like or comment on what you can't see. It's an alias, so the rules can never diverge.                               |
| `canReshare`     | `canViewContent` **and** the author is public                                                                                      | A repost would show a private post to the reposter's audience, who never got the author's approval.                           |
| `canFollow`      | Not yourself, no block either way                                                                                                  | Stops you from following around a block.                                                                                      |
| `canMessage`     | No block either way, not yourself, **and** (recipient allows `everyone` **or** recipient follows you **or** recipient wrote first) | A "following only" account could otherwise message people who can't reply.                                                    |

### canViewContent cases to memorize

| Viewer's situation                        | Public author | Private author |
| ----------------------------------------- | ------------- | -------------- |
| Is the author                             | yes           | yes            |
| Approved follower (`following: 'active'`) | yes           | yes            |
| Pending request (`following: 'pending'`)  | yes           | **no**         |
| Not following                             | yes           | **no**         |
| Either side blocked the other             | **no**        | **no**         |

### Small type trick: minimal inputs

The second arguments are tiny structural types: `Author = { isPrivate }` and `Recipient = { messagePolicy }`. Because TypeScript is structurally typed, callers can pass a full `UserRecord`, a cached author summary, or a test literal like `{ isPrivate: true }`. Nothing needs converting, and the policy can't depend on fields it shouldn't care about.

## How modules use it

Modules use the policy in five recurring patterns. Learn the patterns and you can explain any endpoint.

### Who calls what

| Module                          | Functions used                                  | Where                                               |
| ------------------------------- | ----------------------------------------------- | --------------------------------------------------- |
| Users (profile page)            | `canSeeProfile`, `canViewContent`, `canMessage` | `user.service.ts:173-183`                           |
| Follow / follower lists         | `canSeeProfile`, `canViewContent`, `canFollow`  | `follow.service.ts:55, 86`                          |
| Posts (gate)                    | `canViewContent`                                | `post.access.ts:29`                                 |
| Posts (hydrator for lists)      | `canViewContent`, `canReshare`                  | `post.hydrator.ts:59-70`                            |
| Posts (service)                 | `canSeeProfile`, `canViewContent`, `canReshare` | `post.service.ts:72, 167`                           |
| Stories                         | `canSeeProfile`, `canViewContent`               | `story.service.ts:69, 148, 172`                     |
| Search                          | `canSeeProfile`                                 | `search.service.ts:96`                              |
| Messages                        | `canSeeProfile`, `canMessage`                   | `message.service.ts:94-120, 178`                    |
| Comments, engagement            | _indirectly_, via `loadVisiblePost`             | `comment.service.ts:24`, `engagement.service.ts:48` |
| Feed, discovery, bookmarks list | _indirectly_, via `hydratePosts`                | `feed.service.ts:137`, `discovery.service.ts:77`    |

### Pattern A: load, check, throw (single resource)

Used for a profile's stories, posts and follower lists.

```ts
const rel = await getRelationship(viewer.id, userId);
if (!canSeeProfile(rel)) throw Errors.notFound('User not found'); // 404
if (!canViewContent(rel, author)) throw Errors.forbidden('This account is private'); // 403
```

The two checks use two different status codes on purpose:

- **Blocked you → 404.** Identical to "no such user", so the block stays secret.
- **Private account → 403.** The profile header is public anyway, so admitting the account exists leaks nothing.

### Pattern B: a shared gate (`loadVisiblePost`)

`apps/api/src/modules/posts/post.access.ts` wraps the check once for every post-scoped endpoint: likes, comments, bookmarks, reposts, quotes, edits.

```ts
export async function loadVisiblePost(viewerId, postId) {
  const post = await PostModel.findOne({ _id: postId, deletedAt: null }).lean();
  if (!post) throw Errors.notFound('Post not found');
  const author = await requireActiveUser(post.authorId); /* inactive → 404 */
  const rel = await getRelationship(viewerId, author._id);
  if (!canViewContent(rel, author)) throw Errors.notFound('Post not found');
  return { post, author, rel };
}
```

Every failure returns the **same 404**: missing, deleted, author inactive, or not allowed. A 403 here would confirm that a hidden post ID exists. It also returns `rel` and `author`, so callers such as repost can run `canReshare(visible.rel, visible.author)` without reloading anything.

### Pattern C: filter a list in memory

Lists load relationships in one batch, then check each item against the map. Items that fail are dropped silently, with no error.

```ts
// story.service.ts – the story tray
const [authors, relationships] = await Promise.all([findAuthors(ids), getRelationships(viewer.id, ids)]);
for (const story of stories) {
  const rel = relationships.get(authorId);
  if (!author || !rel || !canViewContent(rel, author)) continue;  // skip
  ...
}
```

- **Post hydrator:** `visibleAuthor()` returns `null` for hidden posts. Likes, bookmarks and reposts are only looked up for `visibleIds`. Feed, discovery and bookmarks all pass through `hydratePosts`, so they inherit the filter for free.
- **Search** and the **conversation list** drop entries that fail `canSeeProfile`.

### Pattern D: policy answers as UI flags

The same functions run on the server to tell the client what to show:

```ts
// user.service.ts – profile response
canViewContent: canViewContent(rel, user),
canMessage:     canMessage(rel, user),

// post.hydrator.ts – every post DTO
viewer: { ..., canReshare: mayReshare(post) }
```

The frontend never re-implements the rules. It reads the booleans, so the UI only offers actions the API will accept.

### Pattern E: extra facts passed as arguments

The policy can't query, so when a rule needs more data, the module fetches it and passes it in. In `message.service.ts`:

```ts
if (canMessage(rel, target)) return { allowed: true, rel }; // cheap check first
const wroteFirst = await MessageModel.exists({ conversationId, senderId: oid(otherId) });
return { allowed: canMessage(rel, target, { recipientWroteFirst: wroteFirst !== null }), rel };
```

It runs the cheap check first and only makes the extra query when the answer would otherwise be "no". The profile page skips the query entirely, so its `canMessage` flag can be a conservative "no" in that one rare case. Opening the conversation does the full check.

## Design decisions and trade-offs

These are the points interviewers probe. For each one, know the choice, the reason and what it costs.

| Decision                                               | Why                                                                                                                    | Cost / limitation                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Policy is **pure** (no I/O)                            | Testable without a DB; reusable for single items, lists and UI flags; zero query cost                                  | Callers must load the right data first. Rules that need more facts take them as arguments (`recipientWroteFirst`). |
| One **`Relationship`** shape for every rule            | Every rule reads the same five fields, and one loader feeds them all                                                   | Adding a rule that depends on new data (say, mutes or close friends) means extending the loader and the type.      |
| **Batch loader** (3 queries for N accounts)            | Avoids N+1 on feeds, search, story trays and inboxes                                                                   | Always runs all 3 queries, even when a rule only needs blocks.                                                     |
| **404 for blocks and hidden posts**                    | Doesn't reveal that a block exists or that a private post ID is real (no enumeration)                                  | Harder to debug: "not found" can mean several things.                                                              |
| **403 for a private profile's content**                | The account's existence is already public via its profile, so an honest 403 lets the UI show "This account is private" | None significant. The 404/403 split is deliberate.                                                                 |
| **Mapping errors in services**, not the policy         | Each context words its own message ("User not found", "Post not found", "Conversation not found")                      | Each call site must remember to map correctly. `loadVisiblePost` removes that risk for posts.                      |
| **Cheap check first** in messaging                     | Skips the `MessageModel.exists` query in the common case                                                               | Profile's `canMessage` flag may say "no" when a reply would actually be allowed.                                   |
| **`canInteract = canViewContent`** (alias, not a copy) | Viewing and interacting can never drift apart                                                                          | If they ever need to differ, the alias must become its own function.                                               |

### The known gap: check-then-act races (TOCTOU)

The check runs on data loaded a moment earlier. A block can land between "check passed" and "write committed", for example a follow sent at the same instant the other person blocks you.

The fix is `isBlockedEitherWay(a, b)` in `relationship.service.ts`, a single `BlockModel.exists` query.

- **Follow** (`follow.service.ts:108`): inserts the follow edge, _then_ re-checks. If a block now exists, it deletes the edge and reverts the follower counts.
- **Notifications** (`notification.processor.ts:87`): the background job skips the notification if either side has blocked the other by the time it runs.

**How to say it:** "Pure policies give consistency, not atomicity. For writes where a race matters, we re-verify after the write."

## Interview Q&A

Practice saying these out loud. Each answer is about 30 seconds.

**Q1. How do you handle authorization for content in your app?** All visibility rules live in one module of pure functions, such as `canViewContent(rel, author)`. Services load the target plus a `Relationship` (follow state and blocks both ways), ask the policy, then map "no" to a 404 or 403. No endpoint has its own privacy logic.

**Q2. Why make them pure functions instead of a middleware or a service that queries the DB?** Three reasons. They're unit-testable with plain object literals. They cost no queries, so one rule works for a single item and for a list of 50. And the same function can produce a UI flag like `canReshare`, so frontend and backend always agree. Middleware can't easily do list filtering or per-item flags.

**Q3. How do you avoid N+1 queries when filtering a feed?** `getRelationships(viewerId, authorIds)` resolves every author in 3 indexed queries total: blocks either way, outgoing follows, incoming follows. It returns a `Map`, so the hydrator just does `map.get(authorId)` per post.

**Q4. Why return 404 instead of 403 when someone blocked you?** A 403 confirms the account or post exists, which reveals the block and allows ID enumeration. A 404 is indistinguishable from "doesn't exist". For a private account's content I do return 403, because the profile itself is visible anyway.

**Q5. Can a pending follower see a private account's posts?** No. `canViewContent` requires `following === 'active'`. A pending request grants nothing.

**Q6. Why can't you repost a private account's post even if you follow them?** A repost shows it to _your_ followers, who never got the author's approval. So `canReshare` = `canViewContent` **and** the author is public.

**Q7. What if a rule needs data the policy doesn't have?** The caller fetches it and passes it as an argument, like `canMessage(rel, recipient, { recipientWroteFirst })`. The policy stays pure. The caller also runs the cheap check first and only queries when needed.

**Q8. What's the weakness of this approach?** Check-then-act races: a block can arrive between the check and the write. For follows we insert, then re-check with `isBlockedEitherWay` and undo if blocked. Background notification jobs re-check before delivering.

**Q9. How would you add a "close friends only" story?** Add the new fact to `Relationship` (and its batch loader), then add `canViewCloseFriends(rel, author)` or extend `canViewContent` with an audience argument. Every caller that already uses the policy picks it up, and nothing else changes.

**Q10. How do you test it?** Table-driven unit tests: one `Relationship` literal per case (self, active, pending, none, blocked each way) crossed with public and private authors. Integration tests then confirm endpoints map the results to the right status codes.

## One-minute cheat sheet

- **Where:** `policies/visibility.ts`: 6 pure functions, no I/O.
- **Input:** `Relationship` = `isSelf`, `following`, `followedBy`, `blockedByViewer`, `blockingViewer`.
- **Loader:** `getRelationships`: 3 queries for any number of accounts. Returns a `Map`.
- **Core rule:** self → yes; any block → no; public → yes; private → only `following === 'active'`.
- **Reshare:** viewable **and** public. **Follow:** no self, no block. **Message:** no block, then `everyone` / they follow you / they wrote first.
- **Errors:** blocked or hidden → **404** (don't reveal). Private account → **403**.
- **Five patterns:** (A) check and throw, (B) shared gate `loadVisiblePost`, (C) filter lists in memory, (D) return booleans as UI flags, (E) pass extra facts as arguments.
- **Weakness:** TOCTOU races. Fixed by re-checking `isBlockedEitherWay` after the write.

### Files to open before the interview

| File                                                         | What to look at                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `apps/api/src/policies/visibility.ts`                        | All the rules (60 lines)                                            |
| `apps/api/src/modules/relationships/relationship.service.ts` | `Relationship` type, the 3-query batch loader, `isBlockedEitherWay` |
| `apps/api/src/modules/posts/post.access.ts`                  | `loadVisiblePost`, the uniform-404 gate                             |
| `apps/api/src/modules/posts/post.hydrator.ts`                | List filtering and the `canReshare` UI flag                         |
| `apps/api/src/modules/messages/message.service.ts`           | `mayMessage`, the cheap-check-first reply exception                 |
| `apps/api/src/modules/relationships/follow.service.ts`       | Insert-then-recheck race guard (line 108)                           |
