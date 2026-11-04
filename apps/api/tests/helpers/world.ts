import request from 'supertest';
import { expect } from 'vitest';
import type { Redis } from 'ioredis';
import {
  createTestIdentityProvider,
  newClerkId,
  signSessionToken,
  testTokenVerifier,
} from './auth.js';
import type { AppDependencies } from '../../src/app.js';
import { buildTestApp } from './testApp.js';

export interface TestUser {
  id: string;
  username: string;
  clerkId: string;
  /** Fresh auth headers (tokens are short-lived, so mint per call). */
  headers: () => Promise<{ Authorization: string }>;
}

/**
 * A small world of real, onboarded users driven through the public API, so social tests exercise
 * the same paths clients do instead of writing documents directly.
 */
export function createWorld(redis: Redis, overrides: Partial<AppDependencies> = {}) {
  const identity = createTestIdentityProvider();
  const app = buildTestApp({
    redis,
    tokenVerifier: testTokenVerifier,
    identityProvider: identity.provider,
    ...overrides,
  });

  async function user(
    username: string,
    {
      isPrivate = false,
      displayName = username,
    }: { isPrivate?: boolean; displayName?: string } = {},
  ): Promise<TestUser> {
    const clerkId = identity.add(newClerkId(), { name: username });
    const headers = async () => ({ Authorization: `Bearer ${await signSessionToken(clerkId)}` });
    const res = await request(app)
      .post('/api/v1/users/me/onboarding')
      .set(await headers())
      .send({ username, displayName });
    expect(res.status).toBe(200);
    if (isPrivate) {
      const settings = await request(app)
        .patch('/api/v1/users/me/settings')
        .set(await headers())
        .send({ isPrivate: true });
      expect(settings.status).toBe(200);
    }
    return { id: res.body.data.id as string, username, clerkId, headers };
  }

  /** Authenticated request helpers bound to one user. */
  function as(actor: TestUser) {
    const send = async (
      method: 'get' | 'post' | 'put' | 'patch' | 'delete',
      path: string,
      body?: object,
    ) => {
      const req = request(app)
        [method](`/api/v1${path}`)
        .set(await actor.headers());
      return body ? req.send(body) : req;
    };
    return {
      get: (path: string) => send('get', path),
      post: (path: string, body?: object) => send('post', path, body),
      put: (path: string) => send('put', path),
      patch: (path: string, body: object) => send('patch', path, body),
      delete: (path: string) => send('delete', path),
    };
  }

  async function post(author: TestUser, text: string): Promise<string> {
    const res = await as(author).post('/posts', { text });
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  }

  async function profile(viewer: TestUser, username: string) {
    return (await as(viewer).get(`/users/${username}`)).body.data as {
      counts: { followers: number; following: number; posts: number };
    };
  }

  return { app, user, as, post, profile };
}
