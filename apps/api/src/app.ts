import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import cors from 'cors';
import express, { type Express, type Request } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Env } from './config/env.js';
import { RateLimits } from './config/rateLimits.js';
import type { TokenVerifier } from './infra/clerk.js';
import type { Logger } from './infra/logger.js';
import type { Redis } from './infra/redis.js';
import { createRedisRateLimiter } from './lib/rateLimiter.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestTimeout } from './middleware/timeout.js';
import { createHealthRouter } from './modules/health/health.routes.js';
import type { HealthCheck } from './modules/health/health.service.js';
import type { IdentityProvider } from './modules/users/identity.js';
import { createCommentService } from './modules/comments/comment.service.js';
import type { FeedQueue } from './modules/feed/feed.queue.js';
import type { MediaProvider } from './infra/imagekit.js';
import { createFeedRouter } from './modules/feed/feed.routes.js';
import { createMediaRouter } from './modules/media/media.routes.js';
import { createMediaService } from './modules/media/media.service.js';
import { createStoryRouters } from './modules/stories/story.routes.js';
import { createStoryService } from './modules/stories/story.service.js';
import { createFeedService } from './modules/feed/feed.service.js';
import { createFeedWriter } from './modules/feed/feed.writer.js';
import { createTimelineStore } from './modules/feed/timeline.store.js';
import { createEngagementService } from './modules/engagement/engagement.service.js';
import { createContentRouters } from './modules/posts/content.routes.js';
import { createPostService } from './modules/posts/post.service.js';
import { createBlockService } from './modules/relationships/block.service.js';
import { createRelationshipRouter } from './modules/relationships/relationship.routes.js';
import { createSearchRouter } from './modules/search/search.routes.js';
import { createSearchService } from './modules/search/search.service.js';
import { createFollowService } from './modules/relationships/follow.service.js';
import { createUserRouter } from './modules/users/user.routes.js';
import { createUserService } from './modules/users/user.service.js';
import { createClerkWebhookRouter } from './modules/webhooks/clerk.webhook.js';

export interface AppDependencies {
  config: Pick<
    Env,
    | 'CORS_ORIGINS'
    | 'TRUST_PROXY'
    | 'REQUEST_TIMEOUT_MS'
    | 'RATE_LIMIT_ANONYMOUS_PER_MINUTE'
    | 'FEED_CELEBRITY_THRESHOLD'
    | 'CLERK_WEBHOOK_SIGNING_SECRET'
  >;
  logger: Logger;
  healthChecks: Record<string, HealthCheck>;
  redis: Redis;
  /** Infrastructure boundaries are injected so tests can supply local implementations. */
  tokenVerifier: TokenVerifier;
  identityProvider: IdentityProvider;
  /** Where fan-out jobs go. The API only produces; worker.ts consumes. */
  feedQueue: FeedQueue;
  /** Null when ImageKit is not configured: media endpoints then answer 503. */
  mediaProvider: MediaProvider | null;
}

const REQUEST_ID_PATTERN = /^[\w-]{8,128}$/;
const JSON_BODY_LIMIT = '100kb';

/**
 * Builds the Express app without binding a port, so tests can drive it with Supertest
 * and the HTTP server, Socket.IO and shutdown wiring stay in server.ts.
 */
export function createApp({
  config,
  logger,
  healthChecks,
  redis,
  tokenVerifier,
  identityProvider,
  feedQueue,
  mediaProvider,
}: AppDependencies): Express {
  const media = createMediaService({ provider: mediaProvider, logger });
  const users = createUserService({ redis, logger, identity: identityProvider, media });
  const auth = createAuthMiddleware(tokenVerifier, users);
  const limiter = createRedisRateLimiter(redis);
  const timeline = createTimelineStore(redis);
  const feedWriter = createFeedWriter({
    timeline,
    queue: feedQueue,
    celebrityThreshold: config.FEED_CELEBRITY_THRESHOLD,
    logger,
  });
  const feed = createFeedService({ redis, logger, timeline });

  const app = express();

  app.disable('x-powered-by');
  // Needed for correct client IPs (rate limiting) behind a load balancer; 0 = trust nothing.
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      // Honour an upstream request id (e.g. from the load balancer) so logs correlate across hops.
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
      // One compact line per request. Full header dumps are noisy and costly to store, and every
      // extra field logged is another place a secret could leak.
      serializers: {
        req: (req: IncomingMessage & { id?: unknown }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      },
      // Evaluated when the request completes, after authentication has attached the user.
      customProps: (req) => {
        const { user } = req as Request;
        return user ? { userId: user.id } : {};
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true,
      exposedHeaders: [
        'X-Request-Id',
        'X-RateLimit-Limit',
        'X-RateLimit-Remaining',
        'Retry-After',
        'X-Feed-Source',
      ],
    }),
  );

  app.use('/health', createHealthRouter(healthChecks));

  app.use(requestTimeout(config.REQUEST_TIMEOUT_MS));
  // Webhooks are authenticated by signature, need the raw body, and are not user-rate-limited.
  app.use(
    '/api/v1/webhooks',
    createClerkWebhookRouter({ users, signingSecret: config.CLERK_WEBHOOK_SIGNING_SECRET }),
  );

  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  // Caps unauthenticated traffic (including bad tokens) before any token verification work.
  app.use(
    '/api/v1',
    rateLimit(limiter, { ...RateLimits.anonymous, limit: config.RATE_LIMIT_ANONYMOUS_PER_MINUTE }),
  );

  // Every route below requires a verified session. Authentication and the per-user limit run once
  // here; feature routers only add their own stricter limits and the onboarding requirement.
  const api = express.Router();
  api.use(auth.requireAuth, rateLimit(limiter, RateLimits.authenticated));
  const { postRouter, commentRouter, userContentRouter } = createContentRouters({
    posts: createPostService({ feed: feedWriter, media }),
    engagement: createEngagementService(),
    comments: createCommentService(),
    auth,
    limiter,
  });
  api.use('/users', createUserRouter({ users, auth, limiter }));
  api.use('/users', userContentRouter);
  api.use(
    '/users',
    createRelationshipRouter({
      follows: createFollowService({ feed: feedWriter }),
      blocks: createBlockService({ feed: feedWriter }),
      auth,
      limiter,
    }),
  );
  api.use('/posts', postRouter);
  api.use('/comments', commentRouter);
  api.use('/feed', createFeedRouter({ feed, auth }));
  const { storyRouter, userStoriesRouter } = createStoryRouters({
    stories: createStoryService({ media }),
    auth,
    limiter,
  });
  api.use('/stories', storyRouter);
  api.use('/users', userStoriesRouter);
  api.use('/media', createMediaRouter({ media, auth, limiter }));
  api.use('/search', createSearchRouter({ search: createSearchService(), auth, limiter }));
  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
