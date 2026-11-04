import { afterEach, describe, expect, it, vi } from 'vitest';
import { createImageKitProvider, MediaProviderUnavailableError } from '../../src/infra/imagekit.js';

const provider = createImageKitProvider({ publicKey: 'public_x', privateKey: 'private_x' });

const details = {
  fileId: 'f1',
  name: 'abc.jpg',
  filePath: '/vibe/users/u1/post/abc.jpg',
  url: 'https://ik.imagekit.io/x/vibe/users/u1/post/abc.jpg',
  mime: 'image/jpeg',
  size: 1234,
  width: 10,
  height: 20,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const timeout = () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError'));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImageKit client', () => {
  it('retries a lookup once after a timeout and returns the stored file', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(timeout).mockResolvedValueOnce(json(details));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.getFile('f1')).resolves.toMatchObject({
      fileId: 'f1',
      mimeType: 'image/jpeg',
      size: 1234,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 5xx, then reports ImageKit as unavailable rather than a bug', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ message: 'oops' }, 503)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.getFile('f1')).rejects.toBeInstanceOf(MediaProviderUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a definitive answer: a missing file is null after one request', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ message: 'not found' }, 404)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.getFile('missing')).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats deleting an already-deleted file as success, and retries a timed-out delete', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(timeout)
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(provider.deleteFile('f1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
