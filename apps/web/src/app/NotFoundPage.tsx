import { Link } from 'react-router';
import { EmptyState } from '@/components/ui/EmptyState';

export function NotFoundPage() {
  return (
    <EmptyState
      title="This page doesn't exist"
      description="The link may be broken, or the page may have been removed."
      action={
        <Link
          to="/"
          className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-accent-contrast"
        >
          Go home
        </Link>
      }
    />
  );
}
