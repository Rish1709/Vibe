import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdapter } from '@socket.io/redis-adapter';
import type {
  ClientToServerEvents,
  ConversationDto,
  MessageDto,
  ServerToClientEvents,
} from '@vibe/shared';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RealtimeServer } from '../../src/realtime/gateway.js';
import { newClerkId, signSessionToken, testTokenVerifier } from '../helpers/auth.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { buildTestApp } from '../helpers/testApp.js';
import { createWorld, type TestUser } from '../helpers/world.js';

const REDIS_URL = process.env.REDIS_TEST_URL ?? 'redis://localhost:6379/15';
type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe('realtime gateway', () => {
  useTestDatabase();
  const redis = useTestRedis();
  // A per-file channel prefix, so parallel test files never see each other's broadcasts.
  const adapterKey = `test-io-${randomUUID().slice(0, 8)}`;
  const instances: { io: RealtimeServer; http: HttpServer; url: string; redis: Redis[] }[] = [];
  const sockets: ClientSocket[] = [];

  function makeIo(): { io: RealtimeServer; clients: Redis[] } {
    const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const io: RealtimeServer = new Server({
      adapter: createAdapter(pub, sub, { key: adapterKey }),
    });
    return { io, clients: [pub, sub] };
  }

  // Instance A also drives the world (users are created through it); B is a second API process.
  const a = makeIo();
  const world = createWorld(redis, { io: a.io });
  const { as } = world;

  beforeAll(async () => {
    const b = makeIo();
    const appB = buildTestApp({ redis, tokenVerifier: testTokenVerifier, io: b.io });
    for (const [io, app, clients] of [
      [a.io, world.app, a.clients],
      [b.io, appB, b.clients],
    ] as const) {
      const http = createServer(app);
      io.attach(http);
      await new Promise<void>((resolve) => http.listen(0, resolve));
      const { port } = http.address() as AddressInfo;
      instances.push({ io, http, url: `http://localhost:${port}`, redis: [...clients] });
    }
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    for (const instance of instances) {
      await new Promise<void>((resolve) => {
        void instance.io.close(() => resolve());
      });
      await Promise.all(instance.redis.map((client) => client.quit()));
    }
  });

  function open(instance: number, token: string | undefined): ClientSocket {
    const socket: ClientSocket = connect(instances[instance]?.url ?? '', {
      transports: ['websocket'],
      reconnection: false,
      ...(token !== undefined && { auth: { token } }),
    });
    sockets.push(socket);
    return socket;
  }
  async function connected(instance: number, user: TestUser): Promise<ClientSocket> {
    const socket = open(instance, await signSessionToken(user.clerkId));
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  }
  function rejection(socket: ClientSocket): Promise<string | undefined> {
    return new Promise((resolve) => {
      socket.once('connect_error', (err: Error & { data?: { code?: string } }) =>
        resolve(err.data?.code),
      );
    });
  }
  function next<E extends keyof ServerToClientEvents>(
    socket: ClientSocket,
    event: E,
    timeoutMs = 3_000,
  ) {
    return new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`No ${event} within ${timeoutMs}ms`)),
        timeoutMs,
      );
      (socket.once as (e: string, cb: (payload: never) => void) => void)(event, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
  }
  /** Resolves true if the event does NOT arrive within the window. */
  function silence(socket: ClientSocket, event: keyof ServerToClientEvents, windowMs = 400) {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), windowMs);
      (socket.once as (e: string, cb: () => void) => void)(event, () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  it('rejects connections without a valid token, or before onboarding', async () => {
    expect(await rejection(open(0, undefined))).toBe('UNAUTHENTICATED');
    expect(await rejection(open(0, 'not-a-jwt'))).toBe('UNAUTHENTICATED');
    const user = await world.user('ann');
    expect(
      await rejection(
        open(0, await signSessionToken(user.clerkId, { signWithUntrustedKey: true })),
      ),
    ).toBe('UNAUTHENTICATED');
    expect(
      await rejection(open(0, await signSessionToken(user.clerkId, { expiresInSeconds: -60 }))),
    ).toBe('UNAUTHENTICATED');

    // Signed in but no username yet: the same rule as REST.
    const fresh = world.identity.add(newClerkId(), { name: 'Fresh' });
    await request0(fresh); // provisions the account without onboarding
    expect(await rejection(open(0, await signSessionToken(fresh)))).toBe('ONBOARDING_REQUIRED');
  });

  /** Provisions a user by making one authenticated request (no onboarding). */
  async function request0(clerkId: string) {
    const supertest = (await import('supertest')).default;
    await supertest(world.app)
      .get('/api/v1/users/me')
      .set({ Authorization: `Bearer ${await signSessionToken(clerkId)}` });
  }

  it('delivers a message to a recipient connected to a different API instance', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const annSocket = await connected(0, ann);
    const benSocket = await connected(1, ben); // the other instance

    const conversation = (await as(ann).post('/conversations', { userId: ben.id })).body
      .data as ConversationDto;
    const arrivals = Promise.all([next(benSocket, 'message:new'), next(annSocket, 'message:new')]);
    const sent = await as(ann).post(`/conversations/${conversation.id}/messages`, {
      text: 'across instances',
      clientId: randomUUID(),
    });
    expect(sent.status).toBe(201);
    const [toBen, toAnn] = await arrivals;
    expect(toBen).toEqual(sent.body.data as MessageDto);
    expect(toAnn).toEqual(sent.body.data as MessageDto);
  });

  it('relays typing only between the two participants', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const eve = await world.user('eve');
    const annSocket = await connected(0, ann);
    const benSocket = await connected(1, ben);
    const eveSocket = await connected(0, eve);
    const conversation = (await as(ann).post('/conversations', { userId: ben.id })).body
      .data as ConversationDto;

    const typing = next(benSocket, 'typing');
    annSocket.emit('typing', { conversationId: conversation.id });
    expect(await typing).toEqual({ conversationId: conversation.id, userId: ann.id });

    // Eve isn't a member: her signal goes nowhere, and Ann never receives her own.
    const benHearsEve = silence(benSocket, 'typing');
    const annHearsSelf = silence(annSocket, 'typing');
    eveSocket.emit('typing', { conversationId: conversation.id });
    expect(await benHearsEve).toBe(true);
    expect(await annHearsSelf).toBe(true);
  });

  it('reaches every tab of the same user', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const tabs = [await connected(0, ben), await connected(1, ben)];
    const conversation = (await as(ann).post('/conversations', { userId: ben.id })).body
      .data as ConversationDto;
    const arrivals = Promise.all(tabs.map((tab) => next(tab, 'message:new')));
    await as(ann).post(`/conversations/${conversation.id}/messages`, {
      text: 'both tabs',
      clientId: randomUUID(),
    });
    expect((await arrivals).map((m) => m.text)).toEqual(['both tabs', 'both tabs']);
  });
});
