import { Redirect, Stack } from 'expo-router';
import { canAccess, type RouteGroup } from '../auth/roleRouting';
import { useAuthStore } from '../state/authStore';

/** Used by every role group's `_layout.tsx`: not signed in -> /login, wrong role -> /denied. */
export function GroupGuard({ group }: { group: RouteGroup }) {
  const user = useAuthStore((s) => s.user);
  if (!user) return <Redirect href="/login" />;
  if (!canAccess(user.role, group)) return <Redirect href="/denied" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: '#0f172a' } }} />;
}
