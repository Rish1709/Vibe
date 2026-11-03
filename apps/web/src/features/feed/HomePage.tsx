import { SparkIcon } from '@/components/icons';
import { EmptyState } from '@/components/ui/EmptyState';

export function HomePage() {
  return (
    <>
      <header className="sticky top-0 z-10 border-b border-border bg-bg/80 px-4 py-3 backdrop-blur">
        <h1 className="text-lg font-bold">Home</h1>
      </header>
      <EmptyState
        icon={<SparkIcon />}
        title="Your feed is quiet"
        description="Posts from people you follow will show up here."
      />
    </>
  );
}
