import { AppState, Platform, type AppStateStatus } from 'react-native';
import { startConnectivity } from '../realtime/connectivity';
import { focusManager, QueryClient, keepPreviousData } from '@tanstack/react-query';

/** Defaults mirror frontend/src/main.tsx. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: 1,
        staleTime: 30_000,
        gcTime: 60 * 60_000,
        placeholderData: keepPreviousData,
        refetchOnReconnect: 'always',
        networkMode: 'offlineFirst',
      },
      // D7: no mutation is ever retried or queued offline.
      // F4: 'always' = fail fast (-> "No se envió"); 'online' would park the call in a hidden queue.
      mutations: { retry: 0, networkMode: 'always' },
    },
  });
}

export const queryClient = createQueryClient();

/** Wire app foreground + connectivity into TanStack Query. Returns an unsubscribe function. */
export function setupQueryClientListeners(): () => void {
  const onAppState = (status: AppStateStatus) => {
    if (Platform.OS !== 'web') focusManager.setFocused(status === 'active');
  };
  const appSub = AppState.addEventListener('change', onAppState);
  const stopConnectivity = startConnectivity(); // online = POS health OR socket, never internet reachability (C1)
  return () => {
    appSub.remove();
    stopConnectivity();
  };
}
