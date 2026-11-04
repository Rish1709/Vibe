import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** ImageKit's record of a stored file: the server's only trusted source for what was uploaded. */
export interface StoredFile {
  fileId: string;
  name: string;
  filePath: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string | null;
  size: number;
  width: number | null;
  height: number | null;
}

export interface UploadAuth {
  token: string;
  expire: string;
  signature: string;
  publicKey: string;
}

/** Boundary to the media CDN, so services and tests don't depend on ImageKit's API directly. */
export interface MediaProvider {
  uploadUrl: string;
  createUploadAuth(): UploadAuth;
  getFile(fileId: string): Promise<StoredFile | null>;
  deleteFile(fileId: string): Promise<void>;
}

const UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';
const API_URL = 'https://api.imagekit.io/v1/files';
/** Upload credentials are single-use (the token) and short-lived. ImageKit allows at most 1 hour. */
const UPLOAD_AUTH_TTL_SECONDS = 30 * 60;
/**
 * Two attempts must fit inside the API request timeout (15 s by default) with room to spare. ImageKit
 * normally answers in well under 2 s, but was observed taking over 5 s in live testing.
 */
const ATTEMPT_TIMEOUT_MS = 6_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300;

/** ImageKit could not be reached or failed on its side. Callers should report "try again", not a bug. */
export class MediaProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MediaProviderUnavailableError';
  }
}

const isRetryableStatus = (status: number) => status === 429 || status >= 500;

/**
 * Sends an idempotent request (a lookup or a delete), retrying once on timeouts, network errors, 429 and
 * 5xx. Other responses (including 4xx) are returned for the caller to interpret.
 */
async function requestWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
      if (!isRetryableStatus(res.status)) return res;
      lastError = new Error(`ImageKit responded with ${res.status}`);
      await res.body?.cancel();
    } catch (err) {
      lastError = err;
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
  throw new MediaProviderUnavailableError('ImageKit is unavailable', { cause: lastError });
}

const fileDetailsSchema = z.object({
  fileId: z.string(),
  name: z.string(),
  filePath: z.string(),
  url: z.string(),
  thumbnail: z.string().nullish(),
  mime: z.string().nullish(),
  size: z.number(),
  width: z.number().nullish(),
  height: z.number().nullish(),
});

/**
 * Signature = HMAC-SHA1(privateKey, token + expire), hex. The browser sends it with the upload; ImageKit
 * recomputes it to confirm the server authorized this upload. Note what it does NOT cover: folder, file
 * name and size are chosen by the client, which is why completeUpload re-checks the stored file.
 */
export function signUpload(privateKey: string, token: string, expire: string): string {
  return createHmac('sha1', privateKey)
    .update(token + expire)
    .digest('hex');
}

/** Builds the provider when all ImageKit settings are present; otherwise null (uploads disabled). */
export function createMediaProviderFromEnv(env: {
  IMAGEKIT_PUBLIC_KEY?: string | undefined;
  IMAGEKIT_PRIVATE_KEY?: string | undefined;
}): MediaProvider | null {
  if (!env.IMAGEKIT_PUBLIC_KEY || !env.IMAGEKIT_PRIVATE_KEY) return null;
  return createImageKitProvider({
    publicKey: env.IMAGEKIT_PUBLIC_KEY,
    privateKey: env.IMAGEKIT_PRIVATE_KEY,
  });
}

export function createImageKitProvider({
  publicKey,
  privateKey,
}: {
  publicKey: string;
  privateKey: string;
}): MediaProvider {
  // ImageKit's management API uses HTTP Basic auth with the private key as the username.
  const authorization = `Basic ${Buffer.from(`${privateKey}:`).toString('base64')}`;

  return {
    uploadUrl: UPLOAD_URL,

    createUploadAuth() {
      const token = randomUUID();
      const expire = String(Math.floor(Date.now() / 1000) + UPLOAD_AUTH_TTL_SECONDS);
      return { token, expire, signature: signUpload(privateKey, token, expire), publicKey };
    },

    async getFile(fileId) {
      const res = await requestWithRetry(`${API_URL}/${encodeURIComponent(fileId)}/details`, {
        headers: { Authorization: authorization },
      });
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`ImageKit file lookup failed with ${res.status}`);
      const details = fileDetailsSchema.parse(await res.json());
      return {
        fileId: details.fileId,
        name: details.name,
        filePath: details.filePath,
        url: details.url,
        thumbnailUrl: details.thumbnail ?? null,
        mimeType: details.mime ?? null,
        size: details.size,
        width: details.width ?? null,
        height: details.height ?? null,
      };
    },

    async deleteFile(fileId) {
      const res = await requestWithRetry(`${API_URL}/${encodeURIComponent(fileId)}`, {
        method: 'DELETE',
        headers: { Authorization: authorization },
      });
      // Already gone counts as success: deletion is retried by the cleanup job and must be idempotent.
      if (!res.ok && res.status !== 404)
        throw new Error(`ImageKit delete failed with ${res.status}`);
    },
  };
}
