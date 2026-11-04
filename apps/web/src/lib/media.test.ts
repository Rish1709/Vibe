import { afterEach, describe, expect, it, vi } from 'vitest';
import { imageSrcSet, imageUrl, uploadMedia, videoPoster } from './media';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ImageKit delivery URLs', () => {
  const ik = 'https://ik.imagekit.io/vibe/users/u1/post/abc.jpg';

  it('requests a resized, auto-format variant for ImageKit URLs only', () => {
    expect(imageUrl(ik, 640)).toBe(`${ik}?tr=w-640,q-80,f-auto`);
    expect(imageUrl(`${ik}?v=2`, 320)).toBe(`${ik}?v=2&tr=w-320,q-80,f-auto`);
    expect(imageUrl('https://i.pravatar.cc/240?u=1', 640)).toBe('https://i.pravatar.cc/240?u=1');
  });

  it('builds a responsive srcset and a video poster', () => {
    expect(imageSrcSet(ik, [320, 640])).toBe(
      `${ik}?tr=w-320,q-80,f-auto 320w, ${ik}?tr=w-640,q-80,f-auto 640w`,
    );
    expect(imageSrcSet('https://example.com/a.jpg')).toBeUndefined();
    const video = {
      id: '1',
      kind: 'video' as const,
      url: 'https://ik.imagekit.io/v/a.mp4',
      thumbnailUrl: null,
      width: null,
      height: null,
    };
    expect(videoPoster(video)).toBe('https://ik.imagekit.io/v/a.mp4/ik-thumbnail.jpg');
  });
});

describe('uploadMedia', () => {
  it('rejects unsupported files before any network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const pdf = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' });
    await expect(uploadMedia(pdf, 'post')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const huge = new File(['x'], 'big.jpg', { type: 'image/jpeg' });
    Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 });
    await expect(uploadMedia(huge, 'post')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries verification once when the server says ImageKit is temporarily unavailable', async () => {
    // Stands in for the browser's direct upload to ImageKit.
    class FakeXhr {
      status = 200;
      responseText = JSON.stringify({ fileId: 'file_1' });
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      send() {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const media = {
      id: 'm1',
      kind: 'image',
      url: 'https://ik.imagekit.io/x.jpg',
      thumbnailUrl: null,
      width: 1,
      height: 1,
    };
    const replies = [
      { status: 503, body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Try again' } } },
      { status: 200, body: { data: media } },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, 'http://localhost').pathname;
      const reply =
        path === '/api/v1/media/uploads'
          ? {
              status: 201,
              body: {
                data: {
                  mediaId: 'm1',
                  uploadUrl: 'https://upload.imagekit.io/api/v1/files/upload',
                  fields: {},
                },
              },
            }
          : replies.shift();
      return Promise.resolve(
        new Response(JSON.stringify(reply?.body), {
          status: reply?.status ?? 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    await expect(uploadMedia(file, 'avatar')).resolves.toEqual(media);
    // One ticket request, then two verification attempts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
