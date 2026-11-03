import { randomUUID } from 'node:crypto';
import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createRedisRateLimiter, type RateLimiter } from '../../src/lib/rateLimiter.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { rateLimit } from '../../src/middleware/rateLimit.js';
import { useTestRedis } from '../helpers/db.js';
import { silentLogger } from '../helpers/testApp.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const uniqueKey = () => `rl:test:${randomUUID()}`;

describe('sliding-window rate limiter (real Redis)', () => {
  const redis = useTestRedis();

  it('allows up to the limit, then rejects with a bounded retry time', async () => {
    const limiter = createRedisRateLimiter(redis);
    const key = uniqueKey();
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await limiter.consume(key, 5, 10_000));

    expect(results.slice(0, 5).every((r) => r.allowed)).toBe(true);
    expect(results.map((r) => r.remaining).slice(0, 5)).toEqual([4, 3, 2, 1, 0]);
    expect(results[5]).toMatchObject({ allowed: false, remaining: 0 });
    expect(results[5]?.retryAfterMs).toBeGreaterThan(0);
    expect(results[5]?.retryAfterMs).toBeLessThanOrEqual(10_000);
  });

  it('is atomic: concurrent requests never exceed the limit', async () => {
    const limiter = createRedisRateLimiter(redis);
    const key = uniqueKey();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.consume(key, 10, 10_000)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it('keeps separate budgets per key', async () => {
    const limiter = createRedisRateLimiter(redis);
    const [a, b] = [uniqueKey(), uniqueKey()];
    await limiter.consume(a, 1, 10_000);
    expect((await limiter.consume(a, 1, 10_000)).allowed).toBe(false);
    expect((await limiter.consume(b, 1, 10_000)).allowed).toBe(true);
  });

  it('recovers capacity as the window slides', async () => {
    const limiter = createRedisRateLimiter(redis);
    const key = uniqueKey();
    for (let i = 0; i < 3; i++) await limiter.consume(key, 3, 500);
    expect((await limiter.consume(key, 3, 500)).allowed).toBe(false);

    // Two full windows later the previous window no longer counts.
    await sleep(1_100);
    expect((await limiter.consume(key, 3, 500)).allowed).toBe(true);
  });

  it('keeps memory bounded: one hash per subject with at most two windows', async () => {
    const limiter = createRedisRateLimiter(redis);
    const key = uniqueKey();
    for (let i = 0; i < 5; i++) {
      await limiter.consume(key, 100, 200);
      await sleep(120);
    }
    expect(await redis.hlen(key)).toBeLessThanOrEqual(2);
    expect(await redis.pttl(key)).toBeGreaterThan(0);
  });

  it('reloads the script after Redis drops its script cache', async () => {
    const limiter = createRedisRateLimiter(redis);
    await redis.script('FLUSH');
    expect((await limiter.consume(uniqueKey(), 5, 1_000)).allowed).toBe(true);
  });
});

describe('rateLimit middleware', () => {
  const redis = useTestRedis();

  function appWith(limiter: RateLimiter, limit: number) {
    const app = express();
    app.use(pinoHttp({ logger: silentLogger, autoLogging: false }));
    app.get(
      '/',
      rateLimit(limiter, { name: `test-${randomUUID()}`, limit, windowMs: 60_000 }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.use(errorHandler);
    return app;
  }

  it('returns 429 with Retry-After once the limit is exhausted', async () => {
    const app = appWith(createRedisRateLimiter(redis), 2);
    const first = await request(app).get('/');
    expect(first.headers['x-ratelimit-limit']).toBe('2');
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    await request(app).get('/');

    const blocked = await request(app).get('/');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('fails open when the limiter store is unavailable', async () => {
    const broken: RateLimiter = { consume: () => Promise.reject(new Error('ECONNREFUSED')) };
    const res = await request(appWith(broken, 1)).get('/');
    expect(res.status).toBe(200);
  });
});
