import { QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderOptions } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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
    <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } }}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </SafeAreaProvider>
  );
  return { queryClient, ...(await render(ui, { wrapper: Wrapper, ...options })) };
}
