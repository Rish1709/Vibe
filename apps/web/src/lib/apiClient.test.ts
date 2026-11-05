import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, setAuthTokenGetter } from './apiClient';

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

  it('gives up on a request that never answers, instead of spinning forever', async () => {
    // A fetch that only ends when its signal aborts, like a dead connection.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      ),
    );
    const error = await apiRequest('/x', { method: 'DELETE', timeoutMs: 50 }).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ status: 0, code: 'REQUEST_TIMEOUT' });
  });

  it('gives up when the sign-in token never arrives', async () => {
    const fetchMock = mockFetch(json({ data: {} }));
    setAuthTokenGetter(() => new Promise<string | null>(() => undefined));
    try {
      await expect(apiRequest('/x', { timeoutMs: 50 })).rejects.toMatchObject({
        code: 'REQUEST_TIMEOUT',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      setAuthTokenGetter(() => Promise.resolve(null));
    }
  });

  it('still reports a cancel by the caller as a cancel, not a timeout', async () => {
    mockFetch(new DOMException('aborted', 'AbortError'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      apiRequest('/x', { signal: controller.signal, timeoutMs: 50 }),
    ).rejects.toHaveProperty('name', 'AbortError');
  });

  it('lets aborts propagate untouched so React Query can cancel', async () => {
    mockFetch(new DOMException('aborted', 'AbortError'));
    await expect(apiRequest('/x')).rejects.toHaveProperty('name', 'AbortError');
  });
});
