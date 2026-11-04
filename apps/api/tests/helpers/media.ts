import { randomUUID } from 'node:crypto';
import type { UploadTicketDto } from '@vibe/shared';
import { expect } from 'vitest';
import { signUpload, type MediaProvider, type StoredFile } from '../../src/infra/imagekit.js';

export const TEST_IMAGEKIT_PRIVATE_KEY = 'private_test_key';

/**
 * In-memory stand-in for ImageKit (an external CDN). `store()` plays the browser's direct upload: by
 * default it honours the ticket exactly as a well-behaved client would, and overrides let a test act as
 * a malicious client (other folder, other name, bigger or different file than declared).
 */
export function createTestMediaProvider() {
  const files = new Map<string, StoredFile>();
  const deleted: string[] = [];

  const provider: MediaProvider = {
    uploadUrl: 'https://upload.imagekit.test/api/v1/files/upload',
    createUploadAuth() {
      const token = randomUUID();
      const expire = String(Math.floor(Date.now() / 1000) + 1800);
      return {
        token,
        expire,
        signature: signUpload(TEST_IMAGEKIT_PRIVATE_KEY, token, expire),
        publicKey: 'public_test',
      };
    },
    getFile: (fileId) => Promise.resolve(files.get(fileId) ?? null),
    deleteFile: (fileId) => {
      deleted.push(fileId);
      files.delete(fileId);
      return Promise.resolve();
    },
  };

  function store(ticket: UploadTicketDto, overrides: Partial<StoredFile> = {}): string {
    const fileId = `file_${randomUUID().slice(0, 12)}`;
    const name = overrides.name ?? `${ticket.fields.fileName}.jpg`;
    files.set(fileId, {
      name,
      filePath: overrides.filePath ?? `${ticket.fields.folder}/${name}`,
      url: `https://ik.imagekit.test${ticket.fields.folder}/${name}`,
      thumbnailUrl: null,
      mimeType: 'image/jpeg',
      size: 200_000,
      width: 1080,
      height: 1350,
      ...overrides,
      fileId,
    });
    return fileId;
  }

  return { provider, files, deleted, store };
}

type Requester = {
  post: (path: string, body?: object) => Promise<{ status: number; body: { data: unknown } }>;
};

/** Runs the full two-step upload for a well-behaved client and returns the media id. */
export async function uploadMedia(
  client: Requester,
  media: ReturnType<typeof createTestMediaProvider>,
  {
    purpose = 'post',
    mimeType = 'image/jpeg',
    size = 200_000,
  }: { purpose?: 'post' | 'story' | 'avatar'; mimeType?: string; size?: number } = {},
): Promise<string> {
  const ticket = await client.post('/media/uploads', { purpose, mimeType, size });
  expect(ticket.status).toBe(201);
  const data = ticket.body.data as UploadTicketDto;
  const fileId = media.store(data, {
    mimeType,
    size,
    name: `${data.fields.fileName}.${mimeType.split('/')[1]}`,
  });
  const done = await client.post(`/media/uploads/${data.mediaId}/complete`, { fileId });
  expect(done.status).toBe(200);
  return data.mediaId;
}
