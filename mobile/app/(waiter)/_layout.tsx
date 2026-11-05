import { Stack } from 'expo-router';
import { GroupGuard } from '../../src/components/GroupGuard';
import { colors } from '../../src/theme/tokens';

/** WAITER (and MANAGER/ADMIN read access). Tabs live in (tabs); the ticket flow is pushed over them (tab bar hidden). */
export default function Layout() {
  return (
    <GroupGuard group="(waiter)">
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="ticket/[ticketId]/configure/[itemId]"
          options={{ presentation: 'transparentModal', animation: 'slide_from_bottom' }}
        />
        <Stack.Screen name="open-table/[resourceId]" options={{ presentation: 'transparentModal', animation: 'slide_from_bottom' }} />
      </Stack>
    </GroupGuard>
  );
}