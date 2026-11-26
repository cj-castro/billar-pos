import { ApiError, toApiError } from '../api/client';
import i18n from '../i18n';

export type ErrorKind = 'network' | 'timeout' | 'unauthorized' | 'forbidden' | 'notFound' | 'conflict' | 'validation' | 'rateLimit' | 'server' | 'generic';

/** Classify any thrown value (ApiError / AxiosError / Error) into a UI error kind. */
export function errorKind(err: unknown): ErrorKind {
  const e = err instanceof ApiError ? err : toApiError(err);
  if (e.isNetwork) return 'network';
  if (e.isTimeout) return 'timeout';
  switch (e.status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'notFound';
    case 409:
      return 'conflict';
    case 400:
    case 422:
      return 'validation';
    case 429:
      return 'rateLimit';
    default:
      return (e.status ?? 0) >= 500 ? 'server' : 'generic';
  }
}

/**
 * Spanish (or current language) user-facing message for an error. Never exposes raw server text
 * or stack traces. `overrides` maps ApiError.code (e.g. 'BAR_CLOSED') to a screen-specific string.
 */
export function errorMessage(err: unknown, overrides?: Record<string, string>): string {
  const e = err instanceof ApiError ? err : toApiError(err);
  const override = overrides?.[e.code];
  if (override) return override;
  const kind = errorKind(e);
  return i18n.t(`mobile:errors.${kind}`, { code: e.status ?? e.code });
}

/** Short support code for ErrorState ("HTTP_500", "NETWORK_ERROR"). */
export function errorCode(err: unknown): string {
  return (err instanceof ApiError ? err : toApiError(err)).code;
}
