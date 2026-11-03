import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Run tests against the shared package's TypeScript source, so no build step is needed first.
    alias: {
      '@vibe/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    // The first run downloads a MongoDB binary for mongodb-memory-server.
    hookTimeout: 120_000,
    testTimeout: 15_000,
  },
});
