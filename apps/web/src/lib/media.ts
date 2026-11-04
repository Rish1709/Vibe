import {
  createUploadSchema,
  type MediaDto,
  type MediaPurpose,
  type UploadTicketDto,
} from '@vibe/shared';
import { ApiError, apiRequest } from './apiClient';

/**
 * Uploads a file straight from the browser to ImageKit, then asks the API to verify it.
 * The API never handles the bytes, so uploads don't consume API bandwidth or memory.
 * XHR rather than fetch because fetch can't report upload progress.
 */
export async function uploadMedia(
  file: File,
  purpose: MediaPurpose,
  onProgress?: (fraction: number) => void,
): Promise<MediaDto> {
  const declared = { purpose, mimeType: file.type, size: file.size };
  // Same rules as the server, for instant feedback; the server re-checks the stored file regardless.
  const check = createUploadSchema.safeParse(declared);
  if (!check.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      check.error.issues[0]?.message ?? 'Unsupported file',
    );
  }

  const { data: ticket } = await apiRequest<UploadTicketDto>('/api/v1/media/uploads', {
    method: 'POST',
    body: declared,
  });
  const fileId = await sendToImageKit(ticket, file, onProgress);
  return completeUpload(ticket.mediaId, fileId);
}

const COMPLETE_ATTEMPTS = 2;
const COMPLETE_RETRY_DELAY_MS = 1_000;

/**
 * Verification is safe to repeat (the upload stays pending until it succeeds), so a temporary
 * failure is retried instead of making the user pick and upload the file again.
 */
async function completeUpload(mediaId: string, fileId: string): Promise<MediaDto> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { data } = await apiRequest<MediaDto>(`/api/v1/media/uploads/${mediaId}/complete`, {
        method: 'POST',
        body: { fileId },
      });
      return data;
    } catch (err) {
      const temporary = err instanceof ApiError && err.code === 'SERVICE_UNAVAILABLE';
      if (!temporary || attempt >= COMPLETE_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, COMPLETE_RETRY_DELAY_MS));
    }
  }
}

function sendToImageKit(
  ticket: UploadTicketDto,
  file: File,
  onProgress?: (fraction: number) => void,
) {
  return new Promise<string>((resolve, reject) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.fields)) form.append(key, value);
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', ticket.uploadUrl);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { fileId?: string; message?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.fileId) resolve(body.fileId);
        else reject(new ApiError(xhr.status, 'BAD_REQUEST', body.message ?? 'Upload failed'));
      } catch {
        reject(new ApiError(xhr.status, 'BAD_REQUEST', 'Upload failed'));
      }
    };
    xhr.onerror = () =>
      reject(new ApiError(0, 'SERVICE_UNAVAILABLE', 'Upload failed. Check your connection.'));
    xhr.send(form);
  });
}

const isImageKit = (url: string) => {
  try {
    return new URL(url).hostname.endsWith('imagekit.io');
  } catch {
    return false;
  }
};

/**
 * ImageKit resizes, re-encodes (WebP/AVIF via f-auto) and caches variants at the edge from URL
 * parameters, so the browser downloads an image sized for its slot instead of the full original.
 */
export function imageUrl(url: string, width: number): string {
  if (!isImageKit(url)) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}tr=w-${width},q-80,f-auto`;
}

export function imageSrcSet(url: string, widths = [320, 640, 1080]): string | undefined {
  if (!isImageKit(url)) return undefined;
  return widths.map((width) => `${imageUrl(url, width)} ${width}w`).join(', ');
}

/** ImageKit serves a poster frame for any video at this path. */
export function videoPoster(media: MediaDto): string | undefined {
  if (media.thumbnailUrl) return media.thumbnailUrl;
  return isImageKit(media.url) ? `${media.url}/ik-thumbnail.jpg` : undefined;
}
