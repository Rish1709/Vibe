import { createServer } from 'node:http';
import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { createClerkTokenVerifier } from './infra/clerk.js';
import { createLogger } from './infra/logger.js';
import { createMediaProviderFromEnv } from './infra/imagekit.js';
import { createFeedQueue } from './modules/feed/feed.queue.js';
import { createClerkIdentityProvider } from './modules/users/identity.js';
import { connectMongo, disconnectMongo, pingMongo } from './infra/mongo.js';
import { createRedisClient } from './infra/redis.js';
import { registerGracefulShutdown } from './lib/shutdown.js';

const env = parseEnv(process.env);
const logger = createLogger({ level: env.LOG_LEVEL, pretty: env.NODE_ENV === 'development' });

async function main(): Promise<void> {
  await connectMongo(env.MONGODB_URI, {
    maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
    autoIndex: env.NODE_ENV !== 'production',
    logger,
  });

  const redis = createRedisClient(env.REDIS_URL, { name: 'api', logger });
  await redis.connect();
  // A separate connection for the job queue, so queue traffic can't delay cache and rate-limit calls.
  const queueRedis = createRedisClient(env.REDIS_URL, { name: 'queue', logger });
  await queueRedis.connect();
  const feedQueue = createFeedQueue(queueRedis, env.QUEUE_PREFIX);
  const mediaProvider = createMediaProviderFromEnv(env);
  if (!mediaProvider) logger.warn('ImageKit is not configured: media uploads are disabled');

  if (!env.CLERK_WEBHOOK_SIGNING_SECRET) {
    logger.warn('CLERK_WEBHOOK_SIGNING_SECRET is not set: account deletions will not sync');
  }

  let draining = false;
  const app = createApp({
    config: env,
    logger,
    redis,
    tokenVerifier: createClerkTokenVerifier({
      secretKey: env.CLERK_SECRET_KEY,
      jwtKey: env.CLERK_JWT_KEY,
      authorizedParties: env.CLERK_AUTHORIZED_PARTIES ?? env.CORS_ORIGINS,
      logger,
    }),
    identityProvider: createClerkIdentityProvider(env.CLERK_SECRET_KEY),
    feedQueue,
    mediaProvider,
    healthChecks: {
      mongo: pingMongo,
      redis: async () => {
        await redis.ping();
      },
      // Fail readiness as soon as shutdown starts so the load balancer stops routing here
      // while in-flight requests finish.
      lifecycle: () =>
        draining ? Promise.reject(new Error('Instance is draining')) : Promise.resolve(),
    },
  });

  const server = createServer(app);
  // Keep idle sockets open longer than a typical load balancer's 60s idle timeout;
  // otherwise the server can close a socket the LB is about to reuse (sporadic 502s).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  await new Promise<void>((resolve) => server.listen(env.PORT, resolve));
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');

  registerGracefulShutdown({
    logger,
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    steps: [
      {
        name: 'http',
        run: () =>
          new Promise<void>((resolve, reject) => {
            draining = true;
            // Stops accepting connections and resolves once in-flight requests complete.
            server.close((err) => (err ? reject(err) : resolve()));
            server.closeIdleConnections();
          }),
      },
      {
        name: 'queue',
        run: async () => {
          await feedQueue.close();
          await queueRedis.quit();
        },
      },
      {
        name: 'redis',
        run: async () => {
          await redis.quit();
        },
      },
      { name: 'mongo', run: disconnectMongo },
    ],
  });
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
