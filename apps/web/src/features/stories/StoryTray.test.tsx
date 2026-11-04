import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StoryGroupDto } from '@vibe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useStoryViewer } from '@/stores/storyViewer';
import { makeMe, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
  useStoryViewer.setState({ isOpen: false, groups: [], groupIndex: 0, storyIndex: 0 });
});

const story = (id: string, seen: boolean) => ({
  id,
  media: {
    id: `m${id}`,
    kind: 'image' as const,
    url: `https://ik.imagekit.io/s/${id}.jpg`,
    thumbnailUrl: null,
    width: 1080,
    height: 1920,
  },
  caption: id === 's1' ? 'sunset' : null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  viewer: { seen, isAuthor: false },
  viewCount: null,
});

const grace = {
  id: 'g'.repeat(24).replace(/g/g, 'a'),
  username: 'grace',
  displayName: 'Grace Hopper',
  avatarUrl: null,
};
const tray: StoryGroupDto[] = [
  { author: grace, stories: [story('s1', false), story('s2', false)], hasUnseen: true },
];

function renderHome() {
  return mockApi({
    'GET /api/v1/users/me': () => ({ json: { data: makeMe() } }),
    'GET /api/v1/feed': () => ({ json: { data: [], meta: { nextCursor: null } } }),
    'GET /api/v1/stories/tray': () => ({ json: { data: tray } }),
    'POST /api/v1/stories/s1/views': () => ({ json: { data: { seen: true } } }),
    'POST /api/v1/stories/s2/views': () => ({ json: { data: { seen: true } } }),
  });
}

describe('story tray and viewer', () => {
  it('shows followees with unseen stories as highlighted rings', async () => {
    renderHome();
    renderAt('/');
    expect(
      await screen.findByRole('button', { name: "Grace Hopper's story, new" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add to your story' }).length).toBeGreaterThan(0);
  });

  it('opens the viewer, records views as stories play, and closes', async () => {
    const calls = renderHome();
    renderAt('/');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: "Grace Hopper's story, new" }));
    const dialog = await screen.findByRole('dialog', { name: "Grace Hopper's story" });
    expect(within(dialog).getByText('sunset')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/v1/stories/s1/views')).toBe(true),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Next story' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/v1/stories/s2/views')).toBe(true),
    );

    await user.click(within(dialog).getByRole('button', { name: 'Close stories' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The ring is no longer highlighted: views were applied to the tray optimistically.
    expect(await screen.findByRole('button', { name: "Grace Hopper's story" })).toBeInTheDocument();
  });
});
