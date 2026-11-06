import { recordServerDate } from './clockSkew';
import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { getServerUrl } from '../config/serverConfig';

export const API_TIMEOUT_MS = 8000;

/** Normalized error surfaced to every caller. Never contains tokens or request bodies. */
export class ApiError extends Error {
  status: number | null;
  code: string;
  isNetwork: boolean;
  isTimeout: boolean;

  constructor(init: { status?: number | null; code: string; message: string; isNetwork?: boolean; isTimeout?: boolean }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status ?? null;
    this.code = init.code;
    this.isNetwork = init.isNetwork ?? false;
    this.isTimeout = init.isTimeout ?? false;
  }
}

/** Backend error bodies are inconsistent (matrix §0): {error,message} | {error} | {msg} | {message} | HTML. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (axios.isAxiosError(err)) {
    const res = err.response;
    if (!res) {
      const timeout = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
      return new ApiError({
        status: null,
        code: timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        message: timeout ? 'Request timed out' : 'Network error',
        isNetwork: !timeout,
        isTimeout: timeout,
      });
    }
    const data: unknown = res.data;
    let code = `HTTP_${res.status}`;
    let message = `Request failed (${res.status})`;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      if (typeof d.error === 'string') {
        // Sometimes a CODE ("INVALID_PIN"), sometimes a human sentence (tickets.py:1213).
        if (/^[A-Z0-9_]+$/.test(d.error)) code = d.error;
        else message = d.error;
      }
      if (typeof d.message === 'string') message = d.message;
      else if (typeof d.msg === 'string') message = d.msg; // flask-jwt-extended
    }
    // string bodies (HTML error pages from get_or_404 / nginx) keep the generic message.
    return new ApiError({ status: res.status, code, message });
  }
  return new ApiError({ code: 'UNKNOWN', message: err instanceof Error ? err.message : 'Unknown error' });
}

/** Bridge to the auth store (avoids a client <-> store import cycle). */
export interface AuthBridge {
  getAccessToken(): string | null;
  getRefreshToken(): string | null;
  setAccessToken(token: string): void | Promise<void>;
  /** Refresh token definitively rejected (401/422) or missing: drop the session. */
  onSessionExpired(): void | Promise<void>;
}

let bridge: AuthBridge | null = null;
export function setAuthBridge(b: AuthBridge | null) {
  bridge = b;
}

interface ReqConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
  _isRefresh?: boolean;
  _noAuth?: boolean;
}
/** Per-request flags callers may pass. `_noAuth`: no Bearer, no refresh-on-401 (login, verify). */
export type ClientRequestConfig = AxiosRequestConfig & { _noAuth?: boolean };

const client = axios.create({
  timeout: API_TIMEOUT_MS,
  headers: { 'Content-Type': 'application/json' },
});

client.interceptors.request.use((config: ReqConfig) => {
  const base = getServerUrl();
  if (!base) throw new ApiError({ code: 'NO_SERVER', message: 'Server not configured' });
  config.baseURL = `${base}/api/v1`;
  if (!config._noAuth && !config.headers.Authorization) {
    const token = bridge?.getAccessToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Single-flight: concurrent 401s share one refresh call.
let refreshPromise: Promise<string> | null = null;

function refreshOnce(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function doRefresh(): Promise<string> {
  const refresh = bridge?.getRefreshToken();
  const base = getServerUrl();
  if (!refresh) {
    await bridge?.onSessionExpired();
    throw new ApiError({ status: 401, code: 'NO_REFRESH_TOKEN', message: 'Session expired' });
  }
  try {
    const res = await client.post<{ access_token: string }>('/auth/refresh', null, {
      headers: { Authorization: `Bearer ${refresh}` },
      _isRefresh: true,
    } as ClientRequestConfig);
    const token = res.data.access_token;
    // SEC-10: the session ended (logout / user switch) while the refresh was in flight: drop the result.
    if (bridge?.getRefreshToken() !== refresh || getServerUrl() !== base) throw new ApiError({ status: null, code: 'SESSION_ENDED', message: 'Session ended' });
    await bridge?.setAccessToken(token);
    return token;
  } catch (e) {
    const err = toApiError(e);
    // Network blips / 5xx must NOT log the user out (same rule as web client).
    if (err.status === 401 || err.status === 422) await bridge?.onSessionExpired();
    throw err;
  }
}

client.interceptors.response.use(
  (r) => {
    recordServerDate(r.headers?.date);
    return r;
  },
  async (error: unknown) => {
    const cfg = (error as AxiosError)?.config as ReqConfig | undefined;
    // M3/SEC-08: an app-level 401 (INVALID_PIN, INVALID_CREDENTIALS...) carries `error`; an expired JWT has flask-jwt's `{msg}` shape.
    const appCode = (error as AxiosError<{ error?: unknown }>)?.response?.data?.error;
    if (axios.isAxiosError(error) && error.response?.status === 401 && typeof appCode !== 'string' && cfg && !cfg._retry && !cfg._isRefresh && !cfg._noAuth) {
      // A 401 from a host we have since left must not trigger a refresh (or a retry) against the new one.
      if (cfg.baseURL !== `${getServerUrl()}/api/v1`) throw toApiError(error);
      cfg._retry = true;
      const token = await refreshOnce(); // throws ApiError on failure
      cfg.headers.Authorization = `Bearer ${token}`;
      return client(cfg);
    }
    throw toApiError(error);
  },
);

export default client;
