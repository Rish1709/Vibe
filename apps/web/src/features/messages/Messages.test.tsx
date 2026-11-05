import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConversationDto, MessageDto } from '@vibe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSocket } from '@/test/realtimeMock';
import { makeMe, makeProfile, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

const ME = makeMe().id;
const GRACE = 'b'.repeat(24);
const grace = { id: GRACE, username: 'grace', displayName: 'Grace Hopper', avatarUrl: null };

const message = (id: string, senderId: string, text: string, at: string): MessageDto => ({
  id,
  conversationId: 'c1',
  senderId,
  text,
  clientId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  createdAt: at,
});

const conversation = (overrides: Partial<ConversationDto> = {}): ConversationDto => ({
  id: 'c1',
  user: grace,
  lastMessage: null,
  unread: 0,
  otherLastReadAt: null,
  canSend: true,
  ...overrides,
});

describe('messages inbox', () => {
  it('lists conversations with previews, unread counts and a nav badge', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/notifications/unread-counts': () => ({
        json: { data: { messages: 1, notifications: 0 } },
      }),
      'GET /api/v1/conversations': () => ({
        json: {
          data: [
            conversation({
              unread: 2,
              lastMessage: {
                id: 'm1',
                senderId: GRACE,
                text: 'are you there?',
                createdAt: new Date().toISOString(),
              },
            }),
            conversation({
              id: 'c2',
              user: { ...grace, id: 'c'.repeat(24), username: 'alan', displayName: 'Alan Turing' },
              lastMessage: {
                id: 'm2',
                senderId: ME,
                text: 'see you',
                createdAt: new Date().toISOString(),
              },
            }),
          ],
          meta: { nextCursor: null },
        },
      }),
    });
    renderAt('/messages');

    const list = await screen.findByRole('list', { name: 'Conversations' });
    expect(within(list).getByText('are you there?')).toBeInTheDocument();
    expect(within(list).getByLabelText('2 unread')).toBeInTheDocument();
    expect(within(list).getByText('You: see you')).toBeInTheDocument();
    expect(await screen.findAllByRole('link', { name: 'Messages, 1 unread' })).not.toHaveLength(0);
  });
});

describe('a conversation', () => {
  function routes() {
    let thread: MessageDto[] = [
      message('1', GRACE, 'hi ada', new Date(Date.now() - 60_000).toISOString()),
    ];
    return mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/conversations/c1': () => ({ json: { data: conversation() } }),
      'GET /api/v1/conversations/c1/messages': () => ({
        json: { data: thread, meta: { nextCursor: null } },
      }),
      'POST /api/v1/conversations/c1/read': () => ({ json: { data: null } }),
      'POST /api/v1/conversations/c1/messages': (body) => {
        const { text, clientId } = body as { text: string; clientId: string };
        const sent = { ...message('2', ME, text, new Date().toISOString()), clientId };
        thread = [sent, ...thread];
        return { status: 201, json: { data: sent } };
      },
    });
  }

  it('sends a message, shows live replies and typing, and marks them read', async () => {
    const calls = routes();
    renderAt('/messages/c1');
    const user = userEvent.setup();

    const thread = await screen.findByRole('list', { name: 'Messages' });
    expect(within(thread).getByText('hi ada')).toBeInTheDocument();
    // Opening the conversation reads it.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/v1/conversations/c1/read')).toHaveLength(1),
    );

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello grace{Enter}');
    expect(await within(thread).findByText('hello grace')).toBeInTheDocument();
    const send = calls.find((c) => c.method === 'POST' && c.path.endsWith('/messages'));
    expect(send?.body).toMatchObject({ text: 'hello grace', clientId: expect.any(String) });
    // Typing was signalled over the socket while composing.
    expect(fakeSocket.emitted).toContainEqual({
      event: 'typing',
      payload: { conversationId: 'c1' },
    });

    // Grace types, then replies: the indicator shows, then gives way to her message.
    act(() => fakeSocket.serverEmit('typing', { conversationId: 'c1', userId: GRACE }));
    expect(await screen.findByText('Grace Hopper is typing…')).toBeInTheDocument();
    act(() =>
      fakeSocket.serverEmit('message:new', message('3', GRACE, 'hey!', new Date().toISOString())),
    );
    expect(await within(thread).findByText('hey!')).toBeInTheDocument();
    expect(screen.queryByText('Grace Hopper is typing…')).not.toBeInTheDocument();
    // Her new message arrived while the conversation was open: read again.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/v1/conversations/c1/read')).toHaveLength(2),
    );
  });

  it('shows "Seen" once the other person has read my latest message', async () => {
    routes();
    renderAt('/messages/c1');
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Messages' });
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'did you see this{Enter}');
    expect(await screen.findByText('did you see this')).toBeInTheDocument();
    expect(screen.queryByText('Seen')).not.toBeInTheDocument();

    act(() =>
      fakeSocket.serverEmit('conversation:read', {
        conversationId: 'c1',
        userId: GRACE,
        readAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    );
    expect(await screen.findByText('Seen')).toBeInTheDocument();
  });

  it('says so instead of offering a composer when messaging is not allowed', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/conversations/c1': () => ({ json: { data: conversation({ canSend: false }) } }),
      'GET /api/v1/conversations/c1/messages': () => ({
        json: { data: [], meta: { nextCursor: null } },
      }),
    });
    renderAt('/messages/c1');
    expect(await screen.findByText("You can't message this account.")).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  });
});

describe('messaging from a profile', () => {
  it('opens the conversation from the Message button', async () => {
    const profile = makeProfile({ id: GRACE, username: 'grace', displayName: 'Grace Hopper' });
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/users/grace': () => ({ json: { data: profile } }),
      [`GET /api/v1/users/${GRACE}/posts`]: () => ({
        json: { data: [], meta: { nextCursor: null } },
      }),
      [`GET /api/v1/users/${GRACE}/stories`]: () => ({ json: { data: [] } }),
      'POST /api/v1/conversations': () => ({ json: { data: conversation() } }),
      'GET /api/v1/conversations/c1': () => ({ json: { data: conversation() } }),
      'GET /api/v1/conversations/c1/messages': () => ({
        json: { data: [], meta: { nextCursor: null } },
      }),
      'POST /api/v1/conversations/c1/read': () => ({ json: { data: null } }),
    });
    const { router } = renderAt('/grace');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Message' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/messages/c1'));
    expect(
      calls.find((c) => c.method === 'POST' && c.path === '/api/v1/conversations')?.body,
    ).toEqual({
      userId: GRACE,
    });
  });

  it('hides the Message button when their settings do not allow it', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/users/grace': () => ({
        json: { data: makeProfile({ id: GRACE, username: 'grace', canMessage: false }) },
      }),
      [`GET /api/v1/users/${GRACE}/posts`]: () => ({
        json: { data: [], meta: { nextCursor: null } },
      }),
      [`GET /api/v1/users/${GRACE}/stories`]: () => ({ json: { data: [] } }),
    });
    renderAt('/grace');
    expect(await screen.findByRole('button', { name: 'Follow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
  });
});
