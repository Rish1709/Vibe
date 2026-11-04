import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy* waits up to 1s by default. Screens that chain several (mocked) requests can exceed that
// on a loaded machine or CI runner; a longer ceiling costs nothing when things are fast.
configure({ asyncUtilTimeout: 5_000 });

// jsdom does not implement matchMedia; components that follow the system theme need it.
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  cleanup();
});
