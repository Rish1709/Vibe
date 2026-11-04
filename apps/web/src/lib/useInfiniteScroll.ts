import { useEffect, useRef } from 'react';

/**
 * Calls `onReachEnd` when the returned sentinel element scrolls into view.
 * IntersectionObserver instead of scroll listeners: no work on every scroll event, and the browser
 * batches visibility checks off the main thread. `rootMargin` starts loading before the user hits bottom.
 */
export function useInfiniteScroll(onReachEnd: () => void, enabled: boolean) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onReachEnd);

  useEffect(() => {
    callback.current = onReachEnd;
  }, [onReachEnd]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !enabled || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current();
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return sentinel;
}
