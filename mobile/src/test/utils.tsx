import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import '../i18n';
import { __setServerUrlForTests } from '../config/serverConfig';
import { createQueryClient } from '../state/queryClient';

export const TEST_SERVER = 'http://192.168.1.22:8080';

/** Pretend the setup screen has been completed. */
export function mockServerConfig(url: string | null = TEST_SERVER) {
  __setServerUrlForTests(url);
}

/** Render with a fresh QueryClient + i18n (es). */
export async function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  const queryClient = createQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...(await render(ui, { wrapper: Wrapper, ...options })) };
}
