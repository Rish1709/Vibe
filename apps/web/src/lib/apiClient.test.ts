import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from './apiClient';

function mockFetch(response: Response | Error | DOMException) {
  const fn = vi.fn(() =>
    response instanceof Response ? Promise.resolve(response) : Promise.reject(response),
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('returns the success envelope and sends JSON bodies', async () => {
    const fetchMock = mockFetch(json({ data: { id: '1' } }, 201));
    const result = await apiRequest<{ id: string }>('/api/v1/things', {
      method: 'POST',
      body: { a: 1 },
    });

    expect(result.data.id).toBe('1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/things',
      expect.objectContaining({
        method: 'POST',
        body: '{"a":1}',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('turns error envelopes into typed ApiErrors', async () => {
    mockFetch(json({ error: { code: 'FORBIDDEN', message: 'Nope', requestId: 'req-1' } }, 403));
    const error = await apiRequest('/x').catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Nope',
      requestId: 'req-1',
    });
    expect((error as ApiError).isClientError).toBe(true);
  });

  it('handles non-JSON error pages from proxies', async () => {
    mockFetch(new Response('<html>Bad Gateway</html>', { status: 502 }));
    await expect(apiRequest('/x')).rejects.toMatchObject({ status: 502, code: 'INTERNAL_ERROR' });
  });

  it('maps network failures to a retryable error', async () => {
    mockFetch(new TypeError('Failed to fetch'));
    const error = await apiRequest('/x').catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 0, code: 'SERVICE_UNAVAILABLE' });
    expect((error as ApiError).isClientError).toBe(false);
  });

  it('lets aborts propagate untouched so React Query can cancel', async () => {
    mockFetch(new DOMException('aborted', 'AbortError'));
    await expect(apiRequest('/x')).rejects.toHaveProperty('name', 'AbortError');
  });
});
