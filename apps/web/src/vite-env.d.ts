/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin. Leave unset in development to use the Vite proxy (same origin). */
  readonly VITE_API_URL?: string;
  /** Clerk publishable key (pk_test_... / pk_live_...). Public by design. */
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
