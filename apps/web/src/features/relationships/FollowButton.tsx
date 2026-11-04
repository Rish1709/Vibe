import type { FollowState } from '@vibe/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';

interface FollowButtonProps {
  state: FollowState;
  pending?: boolean;
  onChange: (follow: boolean) => void;
  size?: 'sm' | 'md';
}

/**
 * Follow / Requested / Following. Hovering "Following" offers "Unfollow", and "Requested" offers
 * "Cancel", the familiar pattern that avoids a separate unfollow control.
 */
export function FollowButton({ state, pending, onChange, size = 'md' }: FollowButtonProps) {
  const [hovered, setHovered] = useState(false);
  const padding = size === 'sm' ? 'px-4 py-1.5' : '';

  if (state === 'none') {
    return (
      <Button className={padding} loading={pending} onClick={() => onChange(true)}>
        Follow
      </Button>
    );
  }

  const label =
    state === 'active' ? (hovered ? 'Unfollow' : 'Following') : hovered ? 'Cancel' : 'Requested';
  return (
    <Button
      variant={hovered ? 'danger' : 'secondary'}
      className={`${padding} min-w-28`}
      loading={pending}
      aria-label={state === 'active' ? 'Unfollow' : 'Cancel follow request'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      onClick={() => onChange(false)}
    >
      {label}
    </Button>
  );
}
