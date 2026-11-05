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
    // Every file shares one in-memory mongod. Several files deliberately fire bursts of concurrent
    // requests (race tests); with one file per core they starve each other into request timeouts.
    // A few files at a time keeps the race tests strict without making them compete.
    maxWorkers: 4,
  },
});
