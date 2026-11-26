import '../src/i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorState } from '../src/components/ErrorState';
import { ScreenScaffold } from '../src/components/ScreenScaffold';
import { ToastProvider } from '../src/components/Toast';
import { getServerUrl } from '../src/config/serverConfig';
import { connectSocket, disconnectSocket } from '../src/realtime/socket';
import { useAuthStore } from '../src/state/authStore';
import { queryClient, setupQueryClientListeners } from '../src/state/queryClient';
import { colors } from '../src/theme/tokens';

/** Keeps exactly one socket alive while a user is signed in. */
function useRealtimeSession() {
  const userId = useAuthStore((s) => s.user?.id);
  const role = useAuthStore((s) => s.user?.role);
  useEffect(() => {
    const base = getServerUrl();
    if (!userId || !role || !base) {
      disconnectSocket();
      return;
    }
    connectSocket({ baseUrl: base, role, queryClient, getToken: () => useAuthStore.getState().accessToken });
    return disconnectSocket;
  }, [userId, role]);
}

/** SCR-X-02: fatal render error (expo-router uses this for any route that throws). */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <ScreenScaffold testID="screen-error">
      <ErrorState error={error} onRetry={retry} />
    </ScreenScaffold>
  );
}

export default function RootLayout() {
  useEffect(() => setupQueryClientListeners(), []);
  useRealtimeSession();
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <StatusBar style="light" />
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
        </ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}