import { Stack } from 'expo-router';
import { GroupGuard } from '../../src/components/GroupGuard';
import { useReadyNotifications } from '../../src/features/waiter/ready/useReadyNotifications';
import { colors } from '../../src/theme/tokens';

/** Always-on waiter realtime: joins kitchen/bar and toasts READY lines of my tickets, on any screen of the group. */
function WaiterRealtime() {
  useReadyNotifications();
  return null;
}

/** WAITER (and MANAGER/ADMIN read access). Tabs live in (tabs); the ticket flow is pushed over them (tab bar hidden). */
export default function Layout() {
  return (
    <GroupGuard group="(waiter)">
      <WaiterRealtime />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="ticket/[ticketId]/configure/[itemId]"
          options={{ presentation: 'transparentModal', animation: 'slide_from_bottom', contentStyle: { backgroundColor: 'transparent' } }}
        />
        <Stack.Screen name="open-table/[resourceId]" options={{ presentation: 'transparentModal', animation: 'slide_from_bottom', contentStyle: { backgroundColor: 'transparent' } }} />
      </Stack>
    </GroupGuard>
  );
}
