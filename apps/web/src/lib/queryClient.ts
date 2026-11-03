import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './apiClient';

const MAX_RETRIES = 2;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Retrying a 403 or 404 cannot succeed; only transient failures are worth retrying.
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.isClientError) && failureCount < MAX_RETRIES,
      },
      mutations: { retry: false },
    },
  });
}
