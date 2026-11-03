import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeMe, mockApi, renderAt } from '@/test/utils';

vi.mock('@clerk/react', async () => (await import('@/test/clerkMock')).clerkModule);

afterEach(() => {
  vi.unstubAllGlobals();
});

const newcomer = makeMe({ username: null, onboarded: false, displayName: 'Grace Hopper' });

describe('onboarding', () => {
  it('prefills the display name and validates the username on blur', async () => {
    mockApi({ 'GET /api/v1/users/me': () => ({ json: { data: newcomer } }) });
    renderAt('/onboarding');
    const user = userEvent.setup();

    expect(await screen.findByLabelText('Display name')).toHaveValue('Grace Hopper');
    await user.type(screen.getByLabelText('Username'), 'a b');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent(/letters, numbers/i);
  });

  it('shows server-side availability after the user stops typing', async () => {
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: newcomer } }),
      'GET /api/v1/users/username-availability': () => ({
        json: { data: { username: 'grace', available: false } },
      }),
    });
    renderAt('/onboarding');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Username'), 'grace');
    expect(await screen.findByText('That username is taken')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    // Debounced: one request for the settled value, not one per keystroke.
    expect(
      calls.filter((c) => c.path.startsWith('/api/v1/users/username-availability')),
    ).toHaveLength(1);
  });

  it('submits the normalized username and enters the app', async () => {
    const calls = mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: newcomer } }),
      'GET /api/v1/users/username-availability': () => ({
        json: { data: { username: 'grace.h', available: true } },
      }),
      'POST /api/v1/users/me/onboarding': () => ({
        json: { data: makeMe({ username: 'grace.h', displayName: 'Grace Hopper' }) },
      }),
    });
    const { router } = renderAt('/onboarding');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Username'), 'Grace.H');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      username: 'grace.h',
      displayName: 'Grace Hopper',
    });
  });

  it('surfaces a username claimed by someone else in the meantime', async () => {
    mockApi({
      'GET /api/v1/users/me': () => ({ json: { data: newcomer } }),
      'GET /api/v1/users/username-availability': () => ({
        json: { data: { username: 'racer', available: true } },
      }),
      'POST /api/v1/users/me/onboarding': () => ({
        status: 409,
        json: { error: { code: 'USERNAME_TAKEN', message: 'That username is already taken' } },
      }),
    });
    renderAt('/onboarding');
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText('Username'), 'racer');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That username is already taken');
  });
});
