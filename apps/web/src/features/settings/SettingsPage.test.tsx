import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMe, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('settings', () => {
  it('sends only the fields that changed', async () => {
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe({ bio: 'Old bio' }) } }),
      'PATCH /api/v1/users/me': () => ({ json: { data: makeMe({ bio: 'New bio' }) } }),
    });
    renderAt('/settings');
    const user = userEvent.setup();

    const bio = await screen.findByLabelText('Bio');
    await user.clear(bio);
    await user.type(bio, 'New bio');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ bio: 'New bio' });
  });

  it('flips the privacy switch immediately and reverts it if the server fails', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: makeMe({ isPrivate: false }) } }),
      'PATCH /api/v1/users/me/settings': () => ({
        status: 500,
        json: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      }),
    });
    renderAt('/settings');
    const user = userEvent.setup();

    const toggle = await screen.findByRole('switch', { name: 'Private account' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    // Optimistic update applied, then rolled back after the 500.
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(await screen.findByText(/change reverted/i)).toBeInTheDocument();
  });
});
