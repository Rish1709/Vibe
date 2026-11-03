import { pino } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { CacheKeys } from '../../src/cache/keys.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import {
  createTestIdentityProvider,
  newClerkId,
  signSessionToken,
  testTokenVerifier,
} from '../helpers/auth.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { buildTestApp } from '../helpers/testApp.js';

describe('users API', () => {
  useTestDatabase();
  const redis = useTestRedis();

  let identity: ReturnType<typeof createTestIdentityProvider>;
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    identity = createTestIdentityProvider();
    app = buildTestApp({
      redis,
      tokenVerifier: testTokenVerifier,
      identityProvider: identity.provider,
    });
  });

  async function as(clerkId: string) {
    return { Authorization: `Bearer ${await signSessionToken(clerkId)}` };
  }

  /** Creates a Clerk identity and an onboarded Vibe account for it. */
  async function onboardedUser(username: string) {
    const clerkId = identity.add(newClerkId(), { name: username });
    const res = await request(app)
      .post('/api/v1/users/me/onboarding')
      .set(await as(clerkId))
      .send({ username, displayName: `${username} display` });
    expect(res.status).toBe(200);
    return { clerkId, headers: await as(clerkId), id: res.body.data.id as string };
  }

  describe('request logging', () => {
    it('logs one compact line per request, tagged with the user and without credentials', async () => {
      const lines: Record<string, unknown>[] = [];
      const logger = pino(
        { level: 'info' },
        { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      );
      const loggedApp = buildTestApp({
        redis,
        logger,
        tokenVerifier: testTokenVerifier,
        identityProvider: identity.provider,
      });
      const clerkId = identity.add(newClerkId());
      const headers = await as(clerkId);
      const res = await request(loggedApp).get('/api/v1/users/me').set(headers);

      const completed = lines.find((line) => line.msg === 'request completed');
      expect(completed).toMatchObject({
        userId: res.body.data.id,
        req: { method: 'GET', url: '/api/v1/users/me' },
        res: { statusCode: 200 },
      });
      expect(Object.keys(completed?.req as object).sort()).toEqual(['id', 'method', 'url']);
      expect(JSON.stringify(lines)).not.toContain(headers.Authorization.slice(7));
    });
  });

  describe('authentication', () => {
    it('rejects requests without a token', async () => {
      const res = await request(app).get('/api/v1/users/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it.each([
      ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
      ['a malformed token', 'Bearer not-a-jwt'],
      ['an empty bearer', 'Bearer '],
    ])('rejects %s', async (_label, header) => {
      const res = await request(app).get('/api/v1/users/me').set('Authorization', header);
      expect(res.status).toBe(401);
    });

    it.each([
      ['an expired token', { expiresInSeconds: -120 }],
      ['a token for another frontend (azp)', { azp: 'https://evil.example' }],
      ['a token signed by an untrusted key', { signWithUntrustedKey: true }],
    ])('rejects %s', async (_label, options) => {
      const clerkId = identity.add(newClerkId());
      const token = await signSessionToken(clerkId, options);
      const res = await request(app)
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(identity.calls).toHaveLength(0);
    });

    it('provisions the local user from the identity provider on first request', async () => {
      const clerkId = identity.add(newClerkId(), {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
      });
      const res = await request(app)
        .get('/api/v1/users/me')
        .set(await as(clerkId));

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        username: null,
        onboarded: false,
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        counts: { followers: 0, following: 0, posts: 0 },
      });
      expect(await UserModel.countDocuments({ clerkId })).toBe(1);
    });

    it('creates exactly one user under concurrent first requests', async () => {
      const clerkId = identity.add(newClerkId());
      const headers = await as(clerkId);
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => request(app).get('/api/v1/users/me').set(headers)),
      );
      expect(responses.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(await UserModel.countDocuments({ clerkId })).toBe(1);
      expect(new Set(responses.map((r) => r.body.data.id as string)).size).toBe(1);
    });

    it('serves repeat requests from the auth cache without re-provisioning', async () => {
      const clerkId = identity.add(newClerkId());
      await request(app)
        .get('/api/v1/users/me')
        .set(await as(clerkId));
      await request(app)
        .get('/api/v1/users/me')
        .set(await as(clerkId));
      expect(identity.calls).toEqual([clerkId]);
      expect(await redis.get(CacheKeys.authUser(clerkId))).not.toBeNull();
    });

    it('returns 503 when the identity provider is down for a new user', async () => {
      const clerkId = identity.add(newClerkId());
      identity.setFailing(true);
      const res = await request(app)
        .get('/api/v1/users/me')
        .set(await as(clerkId));
      expect(res.status).toBe(503);
      expect(await UserModel.countDocuments({ clerkId })).toBe(0);
    });

    it('blocks deleted accounts', async () => {
      const { clerkId, headers } = await onboardedUser('soon_gone');
      await UserModel.updateOne({ clerkId }, { $set: { deletedAt: new Date() } });
      await redis.del(CacheKeys.authUser(clerkId));

      const res = await request(app).get('/api/v1/users/me').set(headers);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACCOUNT_DELETED');
    });
  });

  describe('onboarding', () => {
    it('requires a username before using onboarded-only routes', async () => {
      const clerkId = identity.add(newClerkId());
      const res = await request(app)
        .get('/api/v1/users/anyone')
        .set(await as(clerkId));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ONBOARDING_REQUIRED');
    });

    it('claims a normalized username and unlocks the account immediately', async () => {
      const clerkId = identity.add(newClerkId());
      const headers = await as(clerkId);
      // Populate the auth cache before onboarding, to prove it is invalidated afterwards.
      await request(app).get('/api/v1/users/me').set(headers);

      const res = await request(app)
        .post('/api/v1/users/me/onboarding')
        .set(headers)
        .send({ username: '  Grace.Hopper ', displayName: 'Grace Hopper' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ username: 'grace.hopper', onboarded: true });

      const profile = await request(app).get('/api/v1/users/grace.hopper').set(headers);
      expect(profile.status).toBe(200);
    });

    it('cannot be completed twice', async () => {
      const { headers } = await onboardedUser('once_only');
      const res = await request(app)
        .post('/api/v1/users/me/onboarding')
        .set(headers)
        .send({ username: 'twice_now', displayName: 'Again' });
      expect(res.status).toBe(409);
    });

    it('rejects a username that is already taken', async () => {
      await onboardedUser('popular');
      const clerkId = identity.add(newClerkId());
      const res = await request(app)
        .post('/api/v1/users/me/onboarding')
        .set(await as(clerkId))
        .send({ username: 'Popular', displayName: 'Copycat' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USERNAME_TAKEN');
    });

    it('lets exactly one of two concurrent claims win', async () => {
      const [a, b] = [identity.add(newClerkId()), identity.add(newClerkId())];
      const [headersA, headersB] = [await as(a), await as(b)];
      // Provision both first, so the race is purely about the username.
      await Promise.all([
        request(app).get('/api/v1/users/me').set(headersA),
        request(app).get('/api/v1/users/me').set(headersB),
      ]);

      const body = { username: 'contested', displayName: 'Racer' };
      const results = await Promise.all([
        request(app).post('/api/v1/users/me/onboarding').set(headersA).send(body),
        request(app).post('/api/v1/users/me/onboarding').set(headersB).send(body),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await UserModel.countDocuments({ username: 'contested' })).toBe(1);
    });

    it.each([['settings'], ['no spaces'], ['ab'], ['..dots']])(
      'rejects the invalid username %j',
      async (username) => {
        const clerkId = identity.add(newClerkId());
        const res = await request(app)
          .post('/api/v1/users/me/onboarding')
          .set(await as(clerkId))
          .send({ username, displayName: 'Someone' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      },
    );

    it('reports username availability, including the caller’s own name', async () => {
      const { headers } = await onboardedUser('mine');
      const check = (username: string) =>
        request(app).get('/api/v1/users/username-availability').query({ username }).set(headers);

      expect((await check('MINE')).body.data).toEqual({ username: 'mine', available: true });
      expect((await check('fresh_name')).body.data.available).toBe(true);
      await onboardedUser('taken_name');
      expect((await check('taken_name')).body.data.available).toBe(false);
      expect((await check('admin')).body.data).toMatchObject({
        available: false,
        reason: 'This username is reserved',
      });
    });
  });

  describe('profiles', () => {
    it('returns public profiles without private fields, case-insensitively', async () => {
      await onboardedUser('public_person');
      const { headers } = await onboardedUser('viewer');

      const res = await request(app).get('/api/v1/users/Public_Person').set(headers);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ username: 'public_person', isPrivate: false });
      expect(res.body.data).not.toHaveProperty('email');
      expect(res.body.data).not.toHaveProperty('clerkId');
    });

    it('returns 404 for unknown and deleted users', async () => {
      const { headers } = await onboardedUser('looker');
      const { clerkId } = await onboardedUser('deleted_one');
      await UserModel.updateOne({ clerkId }, { $set: { deletedAt: new Date() } });

      expect((await request(app).get('/api/v1/users/nobody_here').set(headers)).status).toBe(404);
      expect((await request(app).get('/api/v1/users/deleted_one').set(headers)).status).toBe(404);
    });

    it('updates the profile and clears the website with an empty string', async () => {
      const { headers } = await onboardedUser('editor');
      const first = await request(app)
        .patch('/api/v1/users/me')
        .set(headers)
        .send({ bio: 'Hello', website: 'https://example.com' });
      expect(first.body.data).toMatchObject({ bio: 'Hello', website: 'https://example.com' });

      const cleared = await request(app)
        .patch('/api/v1/users/me')
        .set(headers)
        .send({ website: '' });
      expect(cleared.body.data.website).toBeNull();
    });

    it('renames the user, releasing the old username', async () => {
      const { headers } = await onboardedUser('old_name');
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set(headers)
        .send({ username: 'new_name' });
      expect(res.status).toBe(200);

      expect((await request(app).get('/api/v1/users/me').set(headers)).body.data.username).toBe(
        'new_name',
      );
      expect((await request(app).get('/api/v1/users/old_name').set(headers)).status).toBe(404);
      await onboardedUser('old_name');
    });

    it('rejects renaming to a taken username', async () => {
      await onboardedUser('first_owner');
      const { headers } = await onboardedUser('wannabe');
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set(headers)
        .send({ username: 'first_owner' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('USERNAME_TAKEN');
    });

    it('never accepts identity or counters from the client', async () => {
      const { headers, id } = await onboardedUser('honest');
      const res = await request(app)
        .patch('/api/v1/users/me')
        .set(headers)
        .send({ bio: 'x', counts: { followers: 1_000_000 }, clerkId: 'user_other', _id: id });
      expect(res.status).toBe(400);
      const stored = await UserModel.findById(id).lean();
      expect(stored?.counts.followers).toBe(0);
    });

    it('updates privacy settings', async () => {
      const { headers } = await onboardedUser('private_eye');
      const res = await request(app)
        .patch('/api/v1/users/me/settings')
        .set(headers)
        .send({ isPrivate: true, messagePolicy: 'following' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        isPrivate: true,
        settings: { messagePolicy: 'following' },
      });
    });
  });
});
