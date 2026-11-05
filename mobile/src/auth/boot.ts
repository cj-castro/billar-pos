import { ApiError } from '../api/client';
import * as authApi from '../api/endpoints/auth';
import { loadServerUrl } from '../config/serverConfig';
import { loadLanguage } from '../i18n';
import { useAuthStore } from '../state/authStore';
import { routeForRole } from './roleRouting';

export type BootTarget = '/setup' | '/login' | '/denied' | '/floor' | '/queue' | '/overview' | '/diagnostics';

/**
 * Cold-start decision: server configured? tokens present and still valid? -> destination route.
 * A network failure while validating keeps the cached session (D7: offline reads from cache).
 */
export async function boot(): Promise<BootTarget> {
  const [base] = await Promise.all([loadServerUrl(), loadLanguage()]);
  await useAuthStore.getState().hydrate();
  if (!base) return '/setup';

  const { user } = useAuthStore.getState();
  if (!user) return '/login';

  try {
    // 401 -> client refreshes once; refresh rejected -> store is cleared by the auth bridge.
    const fresh = await authApi.me();
    useAuthStore.getState().setUser({ ...user, ...fresh });
    return routeForRole(fresh.role).href;
  } catch (e) {
    if (e instanceof ApiError && (e.isNetwork || e.isTimeout || (e.status ?? 0) >= 500)) {
      return routeForRole(user.role).href;
    }
    // Session invalid (or any definitive rejection): make sure nothing stale remains.
    if (useAuthStore.getState().user) await useAuthStore.getState().logout();
    return '/login';
  }
}
