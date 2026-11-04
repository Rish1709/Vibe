import { POST_TEXT_MAX, type MeDto, type PostDto } from '@vibe/shared';
import { useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ImageIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ApiError } from '@/lib/apiClient';
import { useCreatePost } from './api';
import { QuotedPost } from './QuotedPost';
import { useUploads, type UploadItem } from './useUploads';

interface PostComposerProps {
  me: MeDto;
  quoted?: PostDto;
  placeholder?: string;
  autoFocus?: boolean;
  onPosted?: (post: PostDto) => void;
}

function UploadPreview({ item, onRemove }: { item: UploadItem; onRemove: () => void }) {
  return (
    <div className="relative aspect-square overflow-hidden rounded-xl border border-border bg-surface">
      {item.kind === 'video' ? (
        <video src={item.previewUrl} muted className="h-full w-full object-cover" />
      ) : (
        <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
      )}
      {item.status === 'uploading' && (
        <div className="absolute inset-x-2 bottom-2 h-1.5 overflow-hidden rounded-full bg-black/40">
          <div
            className="h-full bg-white transition-[width]"
            style={{ width: `${Math.round(item.progress * 100)}%` }}
          />
        </div>
      )}
      {item.status === 'error' && (
        <p className="absolute inset-x-0 bottom-0 bg-danger/90 p-1 text-center text-xs text-white">
          {item.error}
        </p>
      )}
      <button
        type="button"
        aria-label="Remove attachment"
        onClick={onRemove}
        className="absolute top-1.5 right-1.5 flex size-7 items-center justify-center rounded-full bg-black/70 text-white"
      >
        ×
      </button>
    </div>
  );
}

export function PostComposer({
  me,
  quoted,
  placeholder = "What's happening?",
  autoFocus,
  onPosted,
}: PostComposerProps) {
  const [text, setText] = useState('');
  const create = useCreatePost();
  const uploads = useUploads('post');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const inputId = useId();
  const remaining = POST_TEXT_MAX - text.length;
  const hasContent = text.trim().length > 0 || uploads.mediaIds.length > 0;
  const canPost =
    hasContent && remaining >= 0 && !uploads.uploading && !uploads.failed && !create.isPending;

  const submit = () => {
    if (!canPost) return;
    create.mutate(
      {
        ...(text.trim() && { text: text.trim() }),
        ...(uploads.mediaIds.length > 0 && { mediaIds: uploads.mediaIds }),
        ...(quoted && { quotedPostId: quoted.id }),
      },
      {
        onSuccess: (post) => {
          setText('');
          uploads.clear();
          toast.success(quoted ? 'Quote posted' : 'Posted');
          onPosted?.(post);
        },
        onError: (error) =>
          toast.error(error instanceof ApiError ? error.message : 'Could not post'),
      },
    );
  };

  return (
    <div className="flex gap-3 border-b border-border px-4 py-3">
      <Avatar src={me.avatarUrl} name={me.displayName} />
      <div className="min-w-0 flex-1">
        <label htmlFor={`${inputId}-text`} className="sr-only">
          {quoted ? 'Add a comment' : 'New post'}
        </label>
        <textarea
          id={`${inputId}-text`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit();
          }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          rows={quoted ? 2 : 3}
          className="w-full resize-none bg-transparent py-2 text-lg outline-none placeholder:text-muted"
        />
        {uploads.items.length > 0 && (
          <div className="mt-1 grid grid-cols-4 gap-2">
            {uploads.items.map((item) => (
              <UploadPreview key={item.key} item={item} onRemove={() => uploads.remove(item.key)} />
            ))}
          </div>
        )}
        {quoted && <QuotedPost post={quoted} />}
        <div className="mt-2 flex items-center justify-between gap-3">
          {quoted ? (
            <span />
          ) : (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                multiple
                hidden
                onChange={(event) => {
                  if (event.target.files) {
                    const problem = uploads.add(event.target.files);
                    if (problem) toast.error(problem);
                  }
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                aria-label="Add photos or video"
                onClick={() => fileInput.current?.click()}
                className="rounded-full p-2 text-accent hover:bg-surface-hover"
              >
                <ImageIcon className="size-5" />
              </button>
            </>
          )}
          <div className="flex items-center gap-3">
            <span
              aria-live="polite"
              className={`text-sm ${remaining < 0 ? 'text-danger' : remaining < 40 ? 'text-amber-500' : 'text-muted'}`}
            >
              {remaining}
            </span>
            <Button onClick={submit} disabled={!canPost} loading={create.isPending}>
              Post
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
