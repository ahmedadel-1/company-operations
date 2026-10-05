'use client';

import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { ApiError } from '../lib/api';
import { reportAuthProblem } from '../lib/auth-events';

function shouldRetry(failureCount: number, error: unknown): boolean {
  // Client errors are answers, not glitches: retrying a 403/404/409 cannot succeed.
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
    return false;
  }
  return failureCount < 2;
}

export function Providers({ children }: { readonly children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: (error) => reportAuthProblem(error) }),
        mutationCache: new MutationCache({ onError: (error) => reportAuthProblem(error) }),
        defaultOptions: {
          queries: { retry: shouldRetry, refetchOnWindowFocus: true, staleTime: 15_000 },
          mutations: { retry: false },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
