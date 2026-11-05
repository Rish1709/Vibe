import { randomUUID } from 'node:crypto';
import type { ConversationDto, MessageDto, UnreadCountsDto } from '@vibe/shared';
import { describe, expect, it } from 'vitest';
import { ConversationModel, MessageModel } from '../../src/modules/messages/message.models.js';
import { createRecordingPublisher } from '../../src/realtime/publisher.js';
import { useTestDatabase, useTestRedis } from '../helpers/db.js';
import { createWorld, type TestUser } from '../helpers/world.js';

describe('direct messages', () => {
  useTestDatabase();
  const redis = useTestRedis();
  const pushes = createRecordingPublisher();
  const world = createWorld(redis, { realtime: pushes.publisher });
  const { as } = world;

  async function open(from: TestUser, to: TestUser) {
    const res = await as(from).post('/conversations', { userId: to.id });
    expect(res.status).toBe(200);
    return res.body.data as ConversationDto;
  }
  async function send(
    from: TestUser,
    conversationId: string,
    text: string,
    clientId = randomUUID(),
  ) {
    return as(from).post(`/conversations/${conversationId}/messages`, { text, clientId });
  }
  async function counts(user: TestUser) {
    return (await as(user).get('/notifications/unread-counts')).body.data as UnreadCountsDto;
  }

  it('opens one conversation per pair, even under concurrent opens from both sides', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? open(ann, ben) : open(ben, ann))),
    );
    expect(new Set(results.map((c) => c.id)).size).toBe(1);
    expect(await ConversationModel.countDocuments()).toBe(1);
    expect(results[0]).toMatchObject({
      user: { username: 'ben' },
      lastMessage: null,
      canSend: true,
    });
    // Empty conversations stay out of the inbox.
    expect((await as(ann).get('/conversations')).body.data).toEqual([]);
  });

  it('sends, lists the thread newest first, and orders the inbox by latest activity', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const cat = await world.user('cat');
    const withBen = await open(ann, ben);
    const withCat = await open(ann, cat);

    expect((await send(ann, withBen.id, 'hi ben')).status).toBe(201);
    expect((await send(ann, withCat.id, 'hi cat')).status).toBe(201);
    expect((await send(ben, withBen.id, 'hey ann')).status).toBe(201);

    const thread = (await as(ann).get(`/conversations/${withBen.id}/messages`)).body
      .data as MessageDto[];
    expect(thread.map((m) => m.text)).toEqual(['hey ann', 'hi ben']);

    const inbox = (await as(ann).get('/conversations')).body.data as ConversationDto[];
    expect(inbox.map((c) => c.user.username)).toEqual(['ben', 'cat']);
    expect(inbox[0]).toMatchObject({ lastMessage: { text: 'hey ann' }, unread: 1 });
  });

  it('paginates a long thread without gaps or duplicates', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const { id } = await open(ann, ben);
    for (let i = 0; i < 7; i += 1) expect((await send(ann, id, `m${i}`)).status).toBe(201);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=3&cursor=${encodeURIComponent(cursor)}` : '?limit=3';
      const res = await as(ben).get(`/conversations/${id}/messages${query}`);
      seen.push(...(res.body.data as MessageDto[]).map((m) => m.text));
      cursor = res.body.meta.nextCursor as string | null;
    } while (cursor);
    expect(seen).toEqual(['m6', 'm5', 'm4', 'm3', 'm2', 'm1', 'm0']);
  });

  it('treats a retried send (same clientId) as the same message, even when retries race', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const { id } = await open(ann, ben);
    const clientId = randomUUID();

    const first = await send(ann, id, 'only once', clientId);
    expect(first.status).toBe(201);
    const retries = await Promise.all(
      Array.from({ length: 5 }, () => send(ann, id, 'only once', clientId)),
    );
    expect(retries.every((r) => r.status === 200 && r.body.data.id === first.body.data.id)).toBe(
      true,
    );
    expect(await MessageModel.countDocuments()).toBe(1);
    // Side effects happened once: one unread for Ben.
    expect((await counts(ben)).messages).toBe(1);
    const inbox = (await as(ben).get('/conversations')).body.data as ConversationDto[];
    expect(inbox[0]?.unread).toBe(1);
  });

  it('keeps an exact unread count under concurrent sends, and clears it on read', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const { id } = await open(ann, ben);
    const sent = await Promise.all(Array.from({ length: 12 }, (_, i) => send(ann, id, `m${i}`)));
    expect(sent.every((r) => r.status === 201)).toBe(true);

    let inbox = (await as(ben).get('/conversations')).body.data as ConversationDto[];
    expect(inbox[0]?.unread).toBe(12);
    // The preview is the newest message, whichever concurrent update ran last.
    const newest = (await as(ben).get(`/conversations/${id}/messages?limit=1`)).body
      .data as MessageDto[];
    expect(inbox[0]?.lastMessage?.id).toBe(newest[0]?.id);

    expect((await as(ben).post(`/conversations/${id}/read`)).status).toBe(204);
    inbox = (await as(ben).get('/conversations')).body.data as ConversationDto[];
    expect(inbox[0]?.unread).toBe(0);
    expect((await counts(ben)).messages).toBe(0);
    // Ann sees when Ben read it.
    const annView = (await as(ann).get(`/conversations/${id}`)).body.data as ConversationDto;
    expect(annView.otherLastReadAt).not.toBeNull();
  });

  it('pushes new messages to both participants and read receipts to both', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const { id } = await open(ann, ben);
    pushes.sent.length = 0;

    const message = (await send(ann, id, 'ping')).body.data as MessageDto;
    expect(pushes.sent.filter((p) => p.event === 'message:new')).toEqual([
      { userId: ben.id, event: 'message:new', payload: message },
      { userId: ann.id, event: 'message:new', payload: message },
    ]);

    await as(ben).post(`/conversations/${id}/read`);
    const reads = pushes.sent.filter((p) => p.event === 'conversation:read');
    expect(reads.map((p) => p.userId)).toEqual([ann.id, ben.id]);
    expect(reads[0]?.payload).toMatchObject({ conversationId: id, userId: ben.id });
  });

  it('respects a "following only" message policy, with replies always allowed', async () => {
    const ann = await world.user('ann');
    const picky = await world.user('picky');
    expect(
      (await as(picky).patch('/users/me/settings', { messagePolicy: 'following' })).status,
    ).toBe(200);

    const conversation = await open(ann, picky);
    expect(conversation.canSend).toBe(false);
    expect((await world.profile(ann, 'picky')) as unknown).toMatchObject({ canMessage: false });
    expect((await send(ann, conversation.id, 'hello?')).status).toBe(403);

    // Picky writes first: now Ann may answer, though Picky still doesn't follow her.
    expect((await send(picky, conversation.id, 'hi ann')).status).toBe(201);
    expect((await send(ann, conversation.id, 'hello!')).status).toBe(201);

    // And once Picky follows Ann, Ann may message freely.
    const fresh = await world.user('fresh');
    expect((await as(picky).put(`/users/${fresh.id}/follow`)).status).toBe(200);
    const withFresh = await open(fresh, picky);
    expect(withFresh.canSend).toBe(true);
    expect((await send(fresh, withFresh.id, 'thanks for the follow')).status).toBe(201);
  });

  it('blocks messaging both ways, and hides the conversation from the blocked side', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const { id } = await open(ann, ben);
    expect((await send(ann, id, 'before')).status).toBe(201);

    expect((await as(ben).put(`/users/${ann.id}/block`)).status).toBe(204);
    // Ann was blocked: Ben disappears for her, as everywhere.
    expect((await send(ann, id, 'after')).status).toBe(404);
    expect((await as(ann).get(`/conversations/${id}/messages`)).status).toBe(404);
    expect((await as(ann).get('/conversations')).body.data).toEqual([]);
    expect((await as(ann).post('/conversations', { userId: ben.id })).status).toBe(404);
    // Ben (the blocker) still sees the history but can't send.
    expect((await send(ben, id, 'nope')).status).toBe(403);
    expect(((await as(ben).get(`/conversations/${id}`)).body.data as ConversationDto).canSend).toBe(
      false,
    );
  });

  it('never shows a conversation to someone outside it', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const eve = await world.user('eve');
    const { id } = await open(ann, ben);
    await send(ann, id, 'private');

    expect((await as(eve).get(`/conversations/${id}`)).status).toBe(404);
    expect((await as(eve).get(`/conversations/${id}/messages`)).status).toBe(404);
    expect((await send(eve, id, 'let me in')).status).toBe(404);
    expect((await as(eve).post(`/conversations/${id}/read`)).status).toBe(404);
  });

  it('validates input and refuses self-conversations', async () => {
    const ann = await world.user('ann');
    const ben = await world.user('ben');
    const { id } = await open(ann, ben);
    expect((await as(ann).post('/conversations', { userId: ann.id })).status).toBe(400);
    expect((await send(ann, id, '   ')).status).toBe(400);
    expect((await send(ann, id, 'x'.repeat(2001))).status).toBe(400);
    expect(
      (await as(ann).post(`/conversations/${id}/messages`, { text: 'hi', clientId: 'not-a-uuid' }))
        .status,
    ).toBe(400);
  });
});
