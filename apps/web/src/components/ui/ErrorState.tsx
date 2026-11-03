import { ApiError } from '@/lib/apiClient';
import { Button } from './Button';
import { EmptyState } from './EmptyState';

interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const message =
    error instanceof ApiError && error.status !== 0 && error.isClientError
      ? error.message
      : 'Something went wrong on our side. Please try again.';
  return (
    <EmptyState
      title="Couldn't load this"
      description={message}
      action={
        onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    />
  );
}
