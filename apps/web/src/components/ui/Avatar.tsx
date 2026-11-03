import { useState } from 'react';

const SIZES = {
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-20 text-2xl sm:size-28 sm:text-3xl',
};

interface AvatarProps {
  src: string | null;
  name: string;
  size?: keyof typeof SIZES;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}

/** Falls back to initials when there is no image or it fails to load. */
export function Avatar({ src, name, size = 'md' }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const base = `${SIZES[size]} shrink-0 rounded-full`;

  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        className={`${base} flex items-center justify-center bg-gradient-to-br from-violet-500 to-pink-500 font-semibold text-white`}
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`${base} bg-surface object-cover`}
    />
  );
}
