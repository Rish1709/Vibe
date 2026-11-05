import { act, screen, waitFor, within } from '@testing-library/react';
import type { NotificationDto } from '@vibe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSocket } from '@/test/realtimeMock';
import { makeMe, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

const actor = {
  id: 'b'.repeat(24),
  username: 'grace',
  displayName: 'Grace Hopper',
  avatarUrl: null,
};
const items: NotificationDto[] = [
  {
    id: 'n1',
    type: 'like',
    actor,
    post: { id: 'p1', text: 'my first post', thumbnailUrl: null },
    comment: null,
    read: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'n2',
    type: 'follow_request',
    actor,
    post: null,
    comment: null,
    read: true,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
];

describe('notifications page', () => {
  it('lists notifications, links each to its target, and marks all read on open', async () => {
    let unread = 1;
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/notifications/unread-counts': () => ({
        json: { data: { messages: 0, notifications: unread } },
      }),
      'GET /api/v1/notifications': () => ({ json: { data: items, meta: { nextCursor: null } } }),
      'POST /api/v1/notifications/read': () => {
        unread = 0;
        return { json: { data: null } };
      },
    });
    renderAt('/notifications');

    const list = await screen.findByRole('list', { name: 'Notifications' });
    const like = within(list).getByRole('link', { name: /Grace Hopper liked your post/ });
    expect(like).toHaveAttribute('href', '/p/p1');
    expect(within(like).getByText('my first post')).toBeInTheDocument();
    expect(within(like).getByText('New')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: /wants to follow you/ })).toHaveAttribute(
      'href',
      '/settings',
    );
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/api/v1/notifications/read'),
      ).toBe(true),
    );
  });

  it('updates the badge live when a notification arrives elsewhere in the app', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
      'GET /api/v1/feed': () => ({ json: { data: [], meta: { nextCursor: null } } }),
      'GET /api/v1/stories/tray': () => ({ json: { data: [] } }),
    });
    renderAt('/');
    expect((await screen.findAllByRole('link', { name: 'Notifications' })).length).toBeGreaterThan(
      0,
    );

    act(() => fakeSocket.serverEmit('notification:new', { type: 'follow', unreadCount: 3 }));
    expect(
      (await screen.findAllByRole('link', { name: 'Notifications, 3 unread' })).length,
    ).toBeGreaterThan(0);

    act(() => fakeSocket.serverEmit('notification:count', { unreadCount: 0 }));
    await waitFor(() =>
      expect(screen.queryAllByRole('link', { name: 'Notifications, 3 unread' })).toHaveLength(0),
    );
  });
});
