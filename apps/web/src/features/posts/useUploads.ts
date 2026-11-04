import { POST_MEDIA_MAX, type MediaDto, type MediaPurpose } from '@vibe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/apiClient';
import { uploadMedia } from '@/lib/media';

export interface UploadItem {
  key: string;
  file: File;
  previewUrl: string;
  kind: 'image' | 'video';
  progress: number;
  status: 'uploading' | 'done' | 'error';
  media?: MediaDto;
  error?: string;
}

/**
 * Manages a set of in-flight uploads for a composer: starts each one as soon as it is picked (so
 * the upload overlaps with typing), tracks progress, and enforces "up to 4 photos or 1 video".
 */
export function useUploads(purpose: MediaPurpose, max = POST_MEDIA_MAX) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const previews = useRef(new Set<string>());

  const update = (key: string, patch: Partial<UploadItem>) =>
    setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));

  const add = useCallback(
    (files: FileList | File[]): string | null => {
      const picked = [...files];
      const hasVideo = picked.some((file) => file.type.startsWith('video/'));
      if (hasVideo && (picked.length > 1 || items.length > 0))
        return 'A post can have one video, or up to 4 photos';
      if (items.some((item) => item.kind === 'video')) return 'Remove the video to add photos';
      if (items.length + picked.length > max) return `You can add up to ${max} photos`;

      for (const file of picked) {
        const key = crypto.randomUUID();
        const previewUrl = URL.createObjectURL(file);
        previews.current.add(previewUrl);
        const kind = file.type.startsWith('video/') ? 'video' : 'image';
        setItems((current) => [
          ...current,
          { key, file, previewUrl, kind, progress: 0, status: 'uploading' },
        ]);
        uploadMedia(file, purpose, (progress) => update(key, { progress }))
          .then((media) => update(key, { status: 'done', progress: 1, media }))
          .catch((err: unknown) =>
            update(key, {
              status: 'error',
              error: err instanceof ApiError ? err.message : 'Upload failed',
            }),
          );
      }
      return null;
    },
    [items, max, purpose],
  );

  const remove = (key: string) => setItems((current) => current.filter((item) => item.key !== key));
  const clear = () => setItems([]);

  // Free the object URLs for previews when the composer goes away.
  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  return {
    items,
    add,
    remove,
    clear,
    uploading: items.some((item) => item.status === 'uploading'),
    failed: items.some((item) => item.status === 'error'),
    mediaIds: items.flatMap((item) => (item.media ? [item.media.id] : [])),
  };
}
