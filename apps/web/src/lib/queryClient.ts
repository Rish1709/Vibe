import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './apiClient';

const MAX_RETRIES = 2;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // React Query's default ('online') *pauses* requests while the browser reports being offline,
      // which looked like a button spinning forever. Sending anyway turns that into a visible error
      // the user can retry. navigator.onLine is also unreliable (it says "online" on a dead Wi-Fi).
      queries: {
        networkMode: 'always',
        staleTime: 30_000,
        // Retrying a 403 or 404 cannot succeed; only transient failures are worth retrying.
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.isClientError) && failureCount < MAX_RETRIES,
      },
      mutations: { networkMode: 'always', retry: false },
    },
  });
}
