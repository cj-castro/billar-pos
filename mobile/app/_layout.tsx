import '../src/i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
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

export default function RootLayout() {
  useEffect(() => setupQueryClientListeners(), []);
  useRealtimeSession();
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
