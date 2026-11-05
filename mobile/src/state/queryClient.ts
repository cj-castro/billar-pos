import { AppState, Platform, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager, QueryClient, keepPreviousData } from '@tanstack/react-query';

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
      mutations: { retry: 0, networkMode: 'online' },
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
  onlineManager.setEventListener((setOnline) =>
    NetInfo.addEventListener((s) => setOnline(s.isConnected !== false && s.isInternetReachable !== false)),
  );
  return () => {
    appSub.remove();
  };
}
