import { Redis } from 'ioredis';
import { pino } from 'pino';
import { createApp, type AppDependencies } from '../../src/app.js';

export const silentLogger = pino({ level: 'silent' });

export const testConfig: AppDependencies['config'] = {
  CORS_ORIGINS: ['http://localhost:5173'],
  TRUST_PROXY: 0,
  REQUEST_TIMEOUT_MS: 5_000,
  CLERK_WEBHOOK_SIGNING_SECRET: undefined,
};

const neverUsed = (name: string) => () =>
  Promise.reject(new Error(`${name} not configured in this test`));

/**
 * Builds the real app. Tests that don't exercise authenticated routes get a Redis client that never
 * connects (lazy) and stubs that fail loudly if reached.
 */
export function buildTestApp(overrides: Partial<AppDependencies> = {}) {
  return createApp({
    config: testConfig,
    logger: silentLogger,
    healthChecks: {},
    redis: new Redis({ lazyConnect: true }),
    tokenVerifier: { verify: neverUsed('tokenVerifier') },
    identityProvider: { getUser: neverUsed('identityProvider') },
    ...overrides,
  });
}
