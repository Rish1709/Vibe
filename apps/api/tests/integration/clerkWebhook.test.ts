import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { UserModel } from '../../src/modules/users/user.model.js';
import { newClerkId } from '../helpers/auth.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { buildTestApp, testConfig } from '../helpers/testApp.js';

const SIGNING_SECRET = `whsec_${randomBytes(24).toString('base64')}`;

/** Signs a payload the way Clerk (via Svix / Standard Webhooks) does. */
function signedHeaders(body: string, { secret = SIGNING_SECRET, timestamp = Date.now() } = {}) {
  const id = `msg_${randomUUID()}`;
  const seconds = Math.floor(timestamp / 1000).toString();
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key).update(`${id}.${seconds}.${body}`).digest('base64');
  return {
    'Content-Type': 'application/json',
    'svix-id': id,
    'svix-timestamp': seconds,
    'svix-signature': `v1,${signature}`,
  };
}

function userEvent(
  type: 'user.created' | 'user.updated',
  clerkId: string,
  {
    updatedAt = Date.now(),
    email = `${clerkId}@example.com`,
    firstName = 'Web',
    lastName = 'Hook',
  } = {},
) {
  return JSON.stringify({
    type,
    object: 'event',
    timestamp: updatedAt,
    instance_id: 'ins_test',
    event_attributes: { http_request: { client_ip: '127.0.0.1', user_agent: 'test' } },
    data: {
      id: clerkId,
      object: 'user',
      first_name: firstName,
      last_name: lastName,
      image_url: 'https://img.example/avatar.png',
      has_image: true,
      primary_email_address_id: 'idn_1',
      email_addresses: [{ id: 'idn_1', object: 'email_address', email_address: email }],
      created_at: updatedAt,
      updated_at: updatedAt,
    },
  });
}

function deletedEvent(clerkId: string, timestamp = Date.now()) {
  return JSON.stringify({
    type: 'user.deleted',
    object: 'event',
    timestamp,
    instance_id: 'ins_test',
    event_attributes: { http_request: { client_ip: '127.0.0.1', user_agent: 'test' } },
    data: { id: clerkId, object: 'user', deleted: true },
  });
}

describe('Clerk webhook', () => {
  useTestDatabase();
  const redis = useTestRedis();
  let app: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    app = buildTestApp({
      redis,
      config: { ...testConfig, CLERK_WEBHOOK_SIGNING_SECRET: SIGNING_SECRET },
    });
  });

  const deliver = (body: string, headers = signedHeaders(body)) =>
    request(app).post('/api/v1/webhooks/clerk').set(headers).send(body);

  it('creates the user from user.created', async () => {
    const clerkId = newClerkId();
    const res = await deliver(userEvent('user.created', clerkId, { email: 'hook@example.com' }));

    expect(res.status).toBe(200);
    const user = await UserModel.findOne({ clerkId }).lean();
    expect(user).toMatchObject({ email: 'hook@example.com', displayName: 'Web Hook' });
  });

  it('is idempotent under duplicate delivery', async () => {
    const clerkId = newClerkId();
    const body = userEvent('user.created', clerkId);
    expect((await deliver(body)).status).toBe(200);
    expect((await deliver(body)).status).toBe(200);
    expect(await UserModel.countDocuments({ clerkId })).toBe(1);
  });

  it('ignores an older update delivered after a newer one', async () => {
    const clerkId = newClerkId();
    const now = Date.now();
    await deliver(userEvent('user.updated', clerkId, { updatedAt: now, email: 'new@example.com' }));
    await deliver(
      userEvent('user.updated', clerkId, { updatedAt: now - 60_000, email: 'old@example.com' }),
    );

    expect((await UserModel.findOne({ clerkId }).lean())?.email).toBe('new@example.com');
  });

  it('does not overwrite a display name the user has changed', async () => {
    const clerkId = newClerkId();
    await deliver(userEvent('user.created', clerkId, { updatedAt: Date.now() - 1_000 }));
    await UserModel.updateOne({ clerkId }, { $set: { displayName: 'Chosen Name' } });
    await deliver(userEvent('user.updated', clerkId, { firstName: 'Provider', lastName: 'Name' }));

    expect((await UserModel.findOne({ clerkId }).lean())?.displayName).toBe('Chosen Name');
  });

  it('soft-deletes on user.deleted and keeps late events from resurrecting the account', async () => {
    const clerkId = newClerkId();
    const createdAt = Date.now() - 10_000;
    await deliver(userEvent('user.created', clerkId, { updatedAt: createdAt }));
    await deliver(deletedEvent(clerkId));
    await deliver(userEvent('user.updated', clerkId, { updatedAt: createdAt + 1 }));

    const user = await UserModel.findOne({ clerkId }).lean();
    expect(user?.deletedAt).toBeInstanceOf(Date);
  });

  it('writes a tombstone when deletion arrives before creation', async () => {
    const clerkId = newClerkId();
    const createdAt = Date.now() - 10_000;
    await deliver(deletedEvent(clerkId));
    await deliver(userEvent('user.created', clerkId, { updatedAt: createdAt }));

    const users = await UserModel.find({ clerkId }).lean();
    expect(users).toHaveLength(1);
    expect(users[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects an invalid signature without touching the database', async () => {
    const clerkId = newClerkId();
    const body = userEvent('user.created', clerkId);
    const forged = signedHeaders(body, { secret: `whsec_${randomBytes(24).toString('base64')}` });

    const res = await deliver(body, forged);
    expect(res.status).toBe(400);
    expect(await UserModel.countDocuments({ clerkId })).toBe(0);
  });

  it('rejects a tampered body', async () => {
    const clerkId = newClerkId();
    const body = userEvent('user.created', clerkId);
    const res = await deliver(body.replace('Web', 'Evil'), signedHeaders(body));
    expect(res.status).toBe(400);
  });

  it('rejects replayed deliveries with stale timestamps', async () => {
    const body = userEvent('user.created', newClerkId());
    const res = await deliver(body, signedHeaders(body, { timestamp: Date.now() - 60 * 60_000 }));
    expect(res.status).toBe(400);
  });

  it('answers 503 when no signing secret is configured', async () => {
    const unconfigured = buildTestApp({ redis });
    const body = userEvent('user.created', newClerkId());
    const res = await request(unconfigured)
      .post('/api/v1/webhooks/clerk')
      .set(signedHeaders(body))
      .send(body);
    expect(res.status).toBe(503);
  });
});
