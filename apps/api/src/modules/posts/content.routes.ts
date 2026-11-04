import {
  createCommentSchema,
  createPostSchema,
  idParamsSchema,
  paginationQuerySchema,
  updatePostSchema,
  type ToggleResultDto,
} from '@vibe/shared';
import { Router } from 'express';
import { RateLimits } from '../../config/rateLimits.js';
import type { RateLimiter } from '../../lib/rateLimiter.js';
import { sendData, sendPage } from '../../lib/response.js';
import { validated } from '../../lib/validate.js';
import { currentUser, type AuthMiddleware } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import type { CommentService } from '../comments/comment.service.js';
import type { EngagementService } from '../engagement/engagement.service.js';
import type { AuthUser } from '../users/user.service.js';
import type { PostService } from './post.service.js';

interface ContentRouterDeps {
  posts: PostService;
  engagement: EngagementService;
  comments: CommentService;
  auth: AuthMiddleware;
  limiter: RateLimiter;
}

const byId = { params: idParamsSchema };
const byIdPaged = { params: idParamsSchema, query: paginationQuerySchema };

/** Builds the /posts, /comments and user-scoped content routers. Handlers only adapt HTTP to services. */
export function createContentRouters({
  posts,
  engagement,
  comments,
  auth,
  limiter,
}: ContentRouterDeps) {
  const postWrites = rateLimit(limiter, RateLimits.postWrites);
  const engagementWrites = rateLimit(limiter, RateLimits.engagementWrites);
  const commentWrites = rateLimit(limiter, RateLimits.commentWrites);

  const postRouter = Router();
  postRouter.use(auth.requireOnboarded);

  postRouter.post(
    '/',
    postWrites,
    validated({ body: createPostSchema }, async ({ body }, req, res) => {
      sendData(res, await posts.create(currentUser(req), body), 201);
    }),
  );
  postRouter.get(
    '/:id',
    validated(byId, async ({ params }, req, res) => {
      sendData(res, await posts.get(currentUser(req), params.id));
    }),
  );
  postRouter.patch(
    '/:id',
    postWrites,
    validated({ ...byId, body: updatePostSchema }, async ({ params, body }, req, res) => {
      sendData(res, await posts.update(currentUser(req), params.id, body));
    }),
  );
  postRouter.delete(
    '/:id',
    postWrites,
    validated(byId, async ({ params }, req, res) => {
      await posts.remove(currentUser(req), params.id);
      res.status(204).end();
    }),
  );

  type Toggle = (viewer: AuthUser, postId: string) => Promise<ToggleResultDto>;
  const toggles: [string, Toggle, Toggle][] = [
    ['like', (u, id) => engagement.like(u, id), (u, id) => engagement.unlike(u, id)],
    ['bookmark', (u, id) => engagement.bookmark(u, id), (u, id) => engagement.unbookmark(u, id)],
    ['repost', (u, id) => posts.repost(u, id), (u, id) => posts.unrepost(u, id)],
  ];
  for (const [path, on, off] of toggles) {
    postRouter.put(
      `/:id/${path}`,
      engagementWrites,
      validated(byId, async ({ params }, req, res) => {
        sendData(res, await on(currentUser(req), params.id));
      }),
    );
    postRouter.delete(
      `/:id/${path}`,
      engagementWrites,
      validated(byId, async ({ params }, req, res) => {
        sendData(res, await off(currentUser(req), params.id));
      }),
    );
  }

  postRouter.get(
    '/:id/likes',
    validated(byIdPaged, async ({ params, query }, req, res) => {
      const { items, meta } = await engagement.listLikers(currentUser(req), params.id, query);
      sendPage(res, items, meta);
    }),
  );
  postRouter.get(
    '/:id/comments',
    validated(byIdPaged, async ({ params, query }, req, res) => {
      const { items, meta } = await comments.listTopLevel(currentUser(req), params.id, query);
      sendPage(res, items, meta);
    }),
  );
  postRouter.post(
    '/:id/comments',
    commentWrites,
    validated({ ...byId, body: createCommentSchema }, async ({ params, body }, req, res) => {
      sendData(res, await comments.create(currentUser(req), params.id, body), 201);
    }),
  );

  const commentRouter = Router();
  commentRouter.use(auth.requireOnboarded);
  commentRouter.get(
    '/:id/replies',
    validated(byIdPaged, async ({ params, query }, req, res) => {
      const { items, meta } = await comments.listReplies(currentUser(req), params.id, query);
      sendPage(res, items, meta);
    }),
  );
  commentRouter.delete(
    '/:id',
    commentWrites,
    validated(byId, async ({ params }, req, res) => {
      await comments.remove(currentUser(req), params.id);
      res.status(204).end();
    }),
  );

  /** Mounted at /users. */
  const userContentRouter = Router();
  userContentRouter.get(
    '/me/bookmarks',
    auth.requireOnboarded,
    validated({ query: paginationQuerySchema }, async ({ query }, req, res) => {
      const { items, meta } = await engagement.listBookmarks(currentUser(req), query);
      sendPage(res, items, meta);
    }),
  );
  userContentRouter.get(
    '/:id/posts',
    auth.requireOnboarded,
    validated(byIdPaged, async ({ params, query }, req, res) => {
      const { items, meta } = await posts.listByAuthor(currentUser(req), params.id, query);
      sendPage(res, items, meta);
    }),
  );

  return { postRouter, commentRouter, userContentRouter };
}
