import { ApiError } from '../api/client';

/** Maps a login failure to a `mobile:login.*` i18n key. */
export function loginErrorKey(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.isTimeout) return 'login.errTimeout';
    if (e.isNetwork) return 'login.errNetwork';
    if (e.status === 401) return 'login.errInvalid';
    if (e.status === 429) return 'login.errRateLimit';
  }
  return 'login.errServer';
}
