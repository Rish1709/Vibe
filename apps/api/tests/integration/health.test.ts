import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { pingMongo } from '../../src/infra/mongo.js';
import { useTestDatabase } from '../helpers/db.js';
import { buildTestApp } from '../helpers/testApp.js';

describe('health endpoints', () => {
  useTestDatabase();

  it('GET /health/live succeeds without touching dependencies', async () => {
    const app = buildTestApp({ healthChecks: { mongo: () => Promise.reject(new Error('down')) } });
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { status: 'ok' } });
  });

  it('GET /health/ready reports up when every dependency answers', async () => {
    const app = buildTestApp({ healthChecks: { mongo: pingMongo } });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'ready',
      checks: { mongo: { status: 'up', latencyMs: expect.any(Number) } },
    });
  });

  it('GET /health/ready returns 503 and names the failing dependency', async () => {
    const app = buildTestApp({
      healthChecks: {
        mongo: pingMongo,
        redis: () => Promise.reject(new Error('ECONNREFUSED')),
      },
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      details: { checks: { mongo: { status: 'up' }, redis: { status: 'down' } } },
    });
    // Internal error messages are logged, not returned.
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('GET /health/ready does not hang on a dependency that never answers', async () => {
    const app = buildTestApp({ healthChecks: { redis: () => new Promise<void>(() => {}) } });
    const startedAt = Date.now();
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });
});
