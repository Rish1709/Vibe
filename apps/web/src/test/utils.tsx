import { render } from '@testing-library/react';
import type { MeDto, PostDto, ProfileDto } from '@vibe/shared';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { AppProviders } from '@/app/providers';
import { appRoutes } from '@/app/routes';

type Handler = (body: unknown) => { status?: number; json: unknown };

/**
 * Stubs `fetch` with a route table keyed by "METHOD /path" (query strings ignored).
 * Unmatched requests fail the test loudly instead of hanging.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = input instanceof Request ? input.url : input.toString();
    const url = new URL(raw, 'http://localhost');
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname + url.search,
      body,
      headers: new Headers(init?.headers),
    });

    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return Promise.reject(new Error(`Unmocked request: ${method} ${url.pathname}`));
    const { status = 200, json } = handler(body);
    return Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

export function renderAt(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const view = render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...view, router };
}

export function makeMe(overrides: Partial<MeDto> = {}): MeDto {
  return {
    id: '65a1b2c3d4e5f60718293a4b',
    username: 'ada',
    displayName: 'Ada Lovelace',
    bio: '',
    website: null,
    avatarUrl: null,
    isPrivate: false,
    counts: { followers: 3, following: 5, posts: 0 },
    createdAt: '2026-01-15T10:00:00.000Z',
    email: 'ada@example.com',
    onboarded: true,
    settings: { messagePolicy: 'everyone' },
    ...overrides,
  };
}

export function makeProfile(overrides: Partial<ProfileDto> = {}): ProfileDto {
  return {
    id: '65a1b2c3d4e5f60718293a4b',
    username: 'ada',
    displayName: 'Ada Lovelace',
    bio: '',
    website: null,
    avatarUrl: null,
    isPrivate: false,
    counts: { followers: 3, following: 5, posts: 1 },
    createdAt: '2026-01-15T10:00:00.000Z',
    viewer: { following: 'none', followedBy: false, blocking: false },
    canViewContent: true,
    ...overrides,
  };
}

let postSeq = 0;
export function makePost(overrides: Partial<PostDto> = {}): PostDto {
  postSeq += 1;
  return {
    id: postSeq.toString(16).padStart(24, '0'),
    kind: 'original',
    author: {
      id: '65a1b2c3d4e5f60718293a4b',
      username: 'ada',
      displayName: 'Ada Lovelace',
      avatarUrl: null,
    },
    text: 'hello world',
    hashtags: [],
    media: [],
    sharedPost: null,
    sharedPostUnavailable: false,
    counts: { likes: 0, comments: 0, reposts: 0 },
    viewer: { liked: false, bookmarked: false, reposted: false, isAuthor: true },
    createdAt: new Date().toISOString(),
    editedAt: null,
    ...overrides,
  };
}
