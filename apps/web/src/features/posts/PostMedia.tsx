import type { MediaDto } from '@vibe/shared';
import { imageSrcSet, imageUrl, videoPoster } from '@/lib/media';

const GRID: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-2 [&>*:first-child]:row-span-2',
  4: 'grid-cols-2',
};

/** Photos in a 1–4 tile grid, or a single video. Images are sized for their slot via ImageKit. */
export function PostMedia({ media }: { media: MediaDto[] }) {
  if (media.length === 0) return null;
  const [first] = media;

  if (first?.kind === 'video') {
    return (
      <video
        src={first.url}
        poster={videoPoster(first)}
        controls
        playsInline
        preload="metadata"
        className="mt-2 max-h-[32rem] w-full rounded-2xl border border-border bg-black"
      />
    );
  }

  const single = media.length === 1;
  return (
    <div
      className={`mt-2 grid gap-0.5 overflow-hidden rounded-2xl border border-border ${GRID[media.length] ?? 'grid-cols-2'} ${
        single ? '' : 'aspect-[16/10]'
      }`}
    >
      {media.map((item) => (
        <img
          key={item.id}
          src={imageUrl(item.url, single ? 1080 : 640)}
          srcSet={imageSrcSet(item.url)}
          sizes={single ? '(max-width: 640px) 100vw, 560px' : '(max-width: 640px) 50vw, 280px'}
          width={item.width ?? undefined}
          height={item.height ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          className={`h-full w-full bg-surface object-cover ${single ? 'max-h-[32rem]' : ''}`}
        />
      ))}
    </div>
  );
}
