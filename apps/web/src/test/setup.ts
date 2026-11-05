import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { fakeSocket } from './realtimeMock';

// No real sockets in UI tests: a fake the test can drive (see realtimeMock.ts).
vi.mock('@/lib/realtime', async () => (await import('./realtimeMock')).realtimeModule);

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

// jsdom has no layout, so no scrolling either; the chat thread scrolls to its newest message.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
  fakeSocket.reset();
});
