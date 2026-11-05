import { Redirect, Stack } from 'expo-router';
import type { ReactNode } from 'react';
import { canAccess, type RouteGroup } from '../auth/roleRouting';
import { useAuthStore } from '../state/authStore';
import { colors } from '../theme/tokens';

/**
 * Used by every role group's `_layout.tsx`: not signed in -> /login, wrong role -> /denied.
 * Renders a headerless Stack (routes are auto-discovered) unless `children` provides a custom one
 * (e.g. a `<Stack>` with a transparentModal screen).
 */
export function GroupGuard({ group, children }: { group: RouteGroup; children?: ReactNode }) {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Redirect href="/login" />;
  if (!canAccess(user.role, group)) return <Redirect href="/denied" />;
  return <>{children ?? <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />}</>;
}
