import { CheckIcon } from '@/components/icons';
import type { AvailabilityState } from './api';

export function UsernameStatus({ state }: { state: AvailabilityState }) {
  switch (state.status) {
    case 'idle':
      return <span>Letters, numbers, underscores and dots.</span>;
    case 'checking':
      return <span aria-live="polite">Checking availability…</span>;
    case 'available':
      return (
        <span
          aria-live="polite"
          className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"
        >
          <CheckIcon className="size-4" /> Available
        </span>
      );
    case 'unavailable':
      return (
        <span aria-live="polite" className="text-danger">
          {state.reason}
        </span>
      );
  }
}
