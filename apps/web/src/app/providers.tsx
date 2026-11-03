import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { createQueryClient } from '@/lib/queryClient';

export function AppProviders({ children }: { children: ReactNode }) {
  // Created once per mounted app (not at module scope) so tests get an isolated cache.
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster position="bottom-center" theme="system" richColors />
    </QueryClientProvider>
  );
}
