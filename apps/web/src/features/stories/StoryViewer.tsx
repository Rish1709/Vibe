import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CloseIcon, EyeIcon } from '@/components/icons';
import { Avatar } from '@/components/ui/Avatar';
import { imageUrl, videoPoster } from '@/lib/media';
import { timeAgo } from '@/lib/time';
import { useStoryViewer } from '@/stores/storyViewer';
import { useDeleteStory, useMarkStoryViewed, useStoryViewers } from './api';

const IMAGE_DURATION_MS = 5_000;

function Viewers({ storyId, count }: { storyId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const viewers = useStoryViewers(storyId, open);
  return (
    <div className="pointer-events-auto">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 text-sm text-white/90"
      >
        <EyeIcon className="size-4" /> {count} {count === 1 ? 'view' : 'views'}
      </button>
      {open && (
        <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto rounded-xl bg-black/70 p-3 text-sm text-white">
          {viewers.data?.length === 0 && <li className="text-white/70">No views yet</li>}
          {viewers.data?.map((user) => (
            <li key={user.id} className="flex items-center gap-2">
              <Avatar src={user.avatarUrl} name={user.displayName} size="sm" />
              {user.username}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Full-screen viewer: progress bars, auto-advance, tap left/right, keyboard, and view tracking. */
export function StoryViewer() {
  const { isOpen, groups, groupIndex, storyIndex, next, previous, close } = useStoryViewer();
  const markViewed = useMarkStoryViewed();
  const remove = useDeleteStory();
  const [progress, setProgress] = useState(0);
  const [paused, setPaused] = useState(false);

  const group = groups[groupIndex];
  const story = group?.stories[storyIndex];
  const isImage = story?.media.kind === 'image';

  // Mark each story seen as it's shown.
  useEffect(() => {
    if (isOpen && story && !story.viewer.isAuthor) markViewed.mutate(story.id);
    setProgress(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per story shown
  }, [isOpen, story?.id]);

  // Images advance on a timer; videos advance when they end (see onEnded below).
  useEffect(() => {
    if (!isOpen || !isImage || paused) return;
    const startedAt = performance.now() - progress * IMAGE_DURATION_MS;
    let frame = requestAnimationFrame(function tick(now) {
      const fraction = Math.min(1, (now - startedAt) / IMAGE_DURATION_MS);
      setProgress(fraction);
      if (fraction >= 1) next();
      else frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart per story, resume after pause
  }, [isOpen, isImage, paused, story?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key === 'ArrowRight') next();
      if (event.key === 'ArrowLeft') previous();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close, next, previous]);

  if (!isOpen || !group || !story) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${group.author.displayName}'s story`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black"
    >
      <div className="relative h-full w-full max-w-md overflow-hidden sm:h-[92vh] sm:rounded-2xl">
        {isImage ? (
          <img
            src={imageUrl(story.media.url, 1080)}
            alt=""
            className="h-full w-full bg-black object-contain"
          />
        ) : (
          <video
            key={story.id}
            src={story.media.url}
            poster={videoPoster(story.media)}
            autoPlay
            playsInline
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              if (video.duration) setProgress(video.currentTime / video.duration);
            }}
            onEnded={next}
            className="h-full w-full bg-black object-contain"
          />
        )}

        {/* Tap zones: left third goes back, the rest goes forward; holding pauses. */}
        <button
          type="button"
          aria-label="Previous story"
          onClick={previous}
          className="absolute inset-y-0 left-0 w-1/3"
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
        />
        <button
          type="button"
          aria-label="Next story"
          onClick={next}
          className="absolute inset-y-0 right-0 w-2/3"
          onPointerDown={() => setPaused(true)}
          onPointerUp={() => setPaused(false)}
        />

        <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/60 to-transparent p-3">
          <div className="flex gap-1">
            {group.stories.map((item, index) => (
              <div key={item.id} className="h-0.5 flex-1 overflow-hidden rounded-full bg-white/30">
                <div
                  className="h-full bg-white"
                  style={{
                    width: `${index < storyIndex ? 100 : index === storyIndex ? progress * 100 : 0}%`,
                  }}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <Link
              to={`/${group.author.username}`}
              onClick={close}
              className="pointer-events-auto flex items-center gap-2 text-sm font-semibold text-white"
            >
              <Avatar src={group.author.avatarUrl} name={group.author.displayName} size="sm" />
              {group.author.username}
              <span className="font-normal text-white/70">{timeAgo(story.createdAt)}</span>
            </Link>
            <button
              type="button"
              aria-label="Close stories"
              onClick={close}
              className="pointer-events-auto rounded-full p-1 text-white"
            >
              <CloseIcon className="size-6" />
            </button>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4">
          {story.caption && <p className="mb-3 text-white">{story.caption}</p>}
          {story.viewer.isAuthor && (
            <div className="flex items-end justify-between gap-3">
              <Viewers storyId={story.id} count={story.viewCount ?? 0} />
              <button
                type="button"
                onClick={() => remove.mutate(story.id, { onSuccess: close })}
                className="pointer-events-auto text-sm text-white/80 hover:text-white"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
