/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.VITE_DEV_API_PROXY ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Consume the shared package's TypeScript source directly (no prebuild needed).
      '@vibe/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Same-origin requests in development: no CORS preflights, and cookies behave like production.
    proxy: {
      '/api': API_TARGET,
      '/health': API_TARGET,
      // The realtime socket (WebSocket upgrade) goes to the API too.
      '/socket.io': { target: API_TARGET, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The first render in a fresh jsdom environment can exceed the 5s default on loaded machines.
    testTimeout: 15_000,
    // Each worker boots its own jsdom. One per core exhausts memory on small machines and workers
    // time out while starting; a few at a time is barely slower.
    maxWorkers: 4,
  },
});
