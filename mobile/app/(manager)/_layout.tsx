import { Stack } from 'expo-router';
import { GroupGuard } from '../../src/components/GroupGuard';
import { colors } from '../../src/theme/tokens';

/** MANAGER and ADMIN (admin = manager + the system tab, decided in SCREEN_TO_CODE_MAPPING.md). */
export default function Layout() {
  return (
    <GroupGuard group="(manager)">
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />
    </GroupGuard>
  );
}