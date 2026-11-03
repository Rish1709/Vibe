import express from 'express';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Errors } from '../../src/lib/errors.js';
import { sendData } from '../../src/lib/response.js';
import { validated } from '../../src/lib/validate.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { notFound } from '../../src/middleware/notFound.js';
import { requestTimeout } from '../../src/middleware/timeout.js';
import { buildTestApp, silentLogger } from '../helpers/testApp.js';

/** A small app wired with the real middleware stack, plus routes that fail in specific ways. */
function buildFailureApp(logger: Logger = silentLogger) {
  const app = express();
  app.use(pinoHttp({ logger, autoLogging: false }));
  app.use(express.json({ limit: '1kb' }));
  app.use(requestTimeout(100));

  app.get('/app-error', () => {
    throw Errors.forbidden();
  });
  app.get('/unavailable', () => {
    throw Errors.serviceUnavailable('Dependency down');
  });
  app.get('/crash', () => {
    throw new Error('database password is hunter2');
  });
  app.get('/async-crash', async () => {
    await Promise.resolve();
    throw new Error('async failure');
  });
  app.get('/duplicate', () => {
    throw Object.assign(new Error('E11000 duplicate key: { username: "alice" }'), { code: 11000 });
  });
  app.get('/slow', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    res.json({ late: true });
  });
  app.post(
    '/items/:id',
    validated(
      {
        params: z.object({ id: z.string().regex(/^\d+$/) }),
        query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
        body: z.object({ name: z.string().min(1), tags: z.array(z.string()).max(2) }).strict(),
      },
      ({ params, query, body }, _req, res) => {
        sendData(res, { id: params.id, dryRun: query.dryRun ?? 'false', name: body.name }, 201);
      },
    ),
  );

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe('error handling', () => {
  const app = buildFailureApp();

  it('serializes AppErrors with status, code and request id', async () => {
    const res = await request(app).get('/app-error');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: { code: 'FORBIDDEN', message: expect.any(String), requestId: expect.any(String) },
    });
  });

  it.each(['/crash', '/async-crash'])('hides internals of unexpected errors (%s)', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('maps unexpected duplicate-key errors to 409 without leaking the key', async () => {
    const res = await request(app).get('/duplicate');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(JSON.stringify(res.body)).not.toContain('alice');
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await request(app)
      .post('/items/1')
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(app)
      .post('/items/1')
      .send({ name: 'x'.repeat(2_000), tags: [] });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 404 in the standard envelope for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('times out slow handlers with 503', async () => {
    const res = await request(app).get('/slow');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('REQUEST_TIMEOUT');
  });
});

describe('error logging', () => {
  function capturingApp() {
    type LogLine = { level: number; msg: string };
    const lines: LogLine[] = [];
    const logger = pino(
      { level: 'info' },
      { write: (line: string) => lines.push(JSON.parse(line) as LogLine) },
    );
    return {
      app: buildFailureApp(logger),
      errorMessages: () => lines.filter((l) => l.level >= 50).map((l) => l.msg),
    };
  }

  it('logs unexpected errors as unhandled', async () => {
    const { app, errorMessages } = capturingApp();
    await request(app).get('/crash');
    expect(errorMessages()).toEqual(['Unhandled error']);
  });

  it('does not log deliberate 5xx AppErrors as unhandled', async () => {
    const { app, errorMessages } = capturingApp();
    const res = await request(app).get('/unavailable');
    expect(res.status).toBe(503);
    expect(errorMessages()).toEqual([]);
  });
});

describe('validated()', () => {
  const app = buildFailureApp();

  it('passes parsed input to the handler', async () => {
    const res = await request(app)
      .post('/items/42?dryRun=true')
      .send({ name: 'vibe', tags: ['a'] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: { id: '42', dryRun: 'true', name: 'vibe' } });
  });

  it('reports issues from every location in one response', async () => {
    const res = await request(app)
      .post('/items/abc?dryRun=maybe')
      .send({ name: '', tags: ['a', 'b', 'c'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const locations = (res.body.error.details as { location: string; path: string }[]).map(
      (issue) => `${issue.location}:${issue.path}`,
    );
    expect(locations).toEqual(
      expect.arrayContaining(['params:id', 'query:dryRun', 'body:name', 'body:tags']),
    );
  });

  it('rejects NoSQL operator payloads and unknown keys', async () => {
    const res = await request(app)
      .post('/items/1')
      .send({ name: { $gt: '' }, tags: [], isAdmin: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('app security headers and request ids', () => {
  const app = buildTestApp();

  it('sets helmet headers and hides the framework', async () => {
    const res = await request(app).get('/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('generates a request id, or propagates a well-formed incoming one', async () => {
    const generated = await request(app).get('/health/live');
    expect(generated.headers['x-request-id']).toMatch(/^[\w-]{8,}$/);

    const propagated = await request(app).get('/health/live').set('X-Request-Id', 'lb-trace-12345');
    expect(propagated.headers['x-request-id']).toBe('lb-trace-12345');

    const rejected = await request(app).get('/health/live').set('X-Request-Id', 'bad id; drop');
    expect(rejected.headers['x-request-id']).not.toBe('bad id; drop');
  });

  it('allows only configured CORS origins', async () => {
    const allowed = await request(app).get('/health/live').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(app).get('/health/live').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});
