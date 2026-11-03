import type { ReactNode } from 'react';

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-bg/80 px-4 py-3 backdrop-blur">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-bold">{title}</h1>
        {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
