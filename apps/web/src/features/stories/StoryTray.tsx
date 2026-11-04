import type { MeDto } from '@vibe/shared';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { PlusIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ApiError } from '@/lib/apiClient';
import { uploadMedia } from '@/lib/media';
import { useStoryViewer } from '@/stores/storyViewer';
import { useCreateStory, useStoryTray } from './api';

const ring = (unseen: boolean) =>
  unseen
    ? 'bg-gradient-to-tr from-amber-400 via-pink-500 to-violet-600 p-[2.5px]'
    : 'bg-border p-[2px]';

/** Picks a file, uploads it, and publishes it as a story with an optional caption. */
function NewStory({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const create = useCreateStory();
  const input = useRef<HTMLInputElement | null>(null);

  const share = async () => {
    if (!file) return;
    try {
      setProgress(0);
      const media = await uploadMedia(file, 'story', setProgress);
      await create.mutateAsync({
        mediaId: media.id,
        ...(caption.trim() && { caption: caption.trim() }),
      });
      toast.success('Story shared');
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not share your story');
      setProgress(null);
    }
  };

  return (
    <div className="border-b border-border px-4 py-3">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
        hidden
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      {file ? (
        <div className="flex flex-col gap-3">
          <p className="truncate text-sm">{file.name}</p>
          <label htmlFor="story-caption" className="sr-only">
            Caption
          </label>
          <input
            id="story-caption"
            value={caption}
            maxLength={200}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Add a caption (optional)"
            className="rounded-full border border-border bg-bg px-4 py-2 text-sm outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button loading={progress !== null} onClick={() => void share()}>
              {progress !== null && progress < 1
                ? `Uploading ${Math.round(progress * 100)}%`
                : 'Share story'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">Stories disappear after 24 hours.</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onDone}>
              Cancel
            </Button>
            <Button onClick={() => input.current?.click()}>Choose photo or video</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function StoryTray({ me }: { me: MeDto }) {
  const tray = useStoryTray();
  const openViewer = useStoryViewer((state) => state.open);
  const [creating, setCreating] = useState(false);

  const groups = tray.data ?? [];
  const ownIndex = groups.findIndex((group) => group.author.id === me.id);

  return (
    <>
      <ul
        aria-label="Stories"
        className="flex gap-4 overflow-x-auto border-b border-border px-4 py-3 [scrollbar-width:none]"
      >
        <li className="flex w-16 shrink-0 flex-col items-center gap-1">
          <div className="relative">
            <button
              type="button"
              aria-label={ownIndex >= 0 ? 'View your story' : 'Add to your story'}
              onClick={() => (ownIndex >= 0 ? openViewer(groups, ownIndex) : setCreating(true))}
              className={`rounded-full ${ring(ownIndex >= 0 && (groups[ownIndex]?.hasUnseen ?? false))}`}
            >
              <span className="block rounded-full bg-bg p-[2px]">
                <Avatar src={me.avatarUrl} name={me.displayName} size="md" />
              </span>
            </button>
            <button
              type="button"
              aria-label="Add to your story"
              onClick={() => setCreating(true)}
              className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full border-2 border-bg bg-accent text-accent-contrast"
            >
              <PlusIcon className="size-3" strokeWidth={3} />
            </button>
          </div>
          <span className="w-full truncate text-center text-xs text-muted">Your story</span>
        </li>

        {groups.map((group, index) =>
          group.author.id === me.id ? null : (
            <li key={group.author.id} className="w-16 shrink-0">
              <button
                type="button"
                aria-label={`${group.author.displayName}'s story${group.hasUnseen ? ', new' : ''}`}
                onClick={() => openViewer(groups, index)}
                className="flex w-full flex-col items-center gap-1"
              >
                <span className={`rounded-full ${ring(group.hasUnseen)}`}>
                  <span className="block rounded-full bg-bg p-[2px]">
                    <Avatar
                      src={group.author.avatarUrl}
                      name={group.author.displayName}
                      size="md"
                    />
                  </span>
                </span>
                <span className="w-full truncate text-center text-xs">{group.author.username}</span>
              </button>
            </li>
          ),
        )}
      </ul>
      {creating && <NewStory onDone={() => setCreating(false)} />}
    </>
  );
}
