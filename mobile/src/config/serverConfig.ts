import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

export const SERVER_URL_KEY = 'bola8.serverUrl';
export const HEALTH_TIMEOUT_MS = 5000;

let current: string | null = null;

/**
 * "192.168.1.22:8080" -> "http://192.168.1.22:8080". Strips whitespace, trailing slashes and a
 * pasted "/api/v1" suffix. Returns null when the input cannot be a base URL.
 * (Regex rather than `URL`: Hermes' URL polyfill is partial.)
 */
export function normalizeServerUrl(input: string): string | null {
  let s = (input ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '').replace(/\/api(\/v1)?$/i, '').replace(/\/+$/, '');
  const m = /^(https?):\/\/([^\s/?#:@]+)(?::(\d{1,5}))?$/i.exec(s);
  if (!m) return null;
  if (m[3] && Number(m[3]) > 65535) return null;
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${m[3] ? `:${m[3]}` : ''}`;
}

export type ServerCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'timeout' | 'unreachable' | 'not_pos' };

/** GET {base}/api/v1/health expecting {status:"ok"}; 5 s timeout. */
export async function validateServer(base: string): Promise<ServerCheck> {
  const url = normalizeServerUrl(base);
  if (!url) return { ok: false, reason: 'invalid' };
  try {
    const res = await axios.get(`${url}/api/v1/health`, {
      timeout: HEALTH_TIMEOUT_MS,
      // Never throw on HTTP status; we classify below.
      validateStatus: () => true,
    });
    const body = res.data as { status?: unknown } | undefined;
    return res.status === 200 && body && typeof body === 'object' && body.status === 'ok'
      ? { ok: true }
      : { ok: false, reason: 'not_pos' };
  } catch (e) {
    const code = (e as { code?: string })?.code;
    return { ok: false, reason: code === 'ECONNABORTED' || code === 'ETIMEDOUT' ? 'timeout' : 'unreachable' };
  }
}

/** Synchronous accessor (valid after loadServerUrl()). */
export function getServerUrl(): string | null {
  return current;
}

export async function loadServerUrl(): Promise<string | null> {
  try {
    current = await AsyncStorage.getItem(SERVER_URL_KEY);
  } catch {
    current = null;
  }
  return current;
}

export async function saveServerUrl(base: string): Promise<string> {
  const url = normalizeServerUrl(base);
  if (!url) throw new Error('INVALID_SERVER_URL');
  await AsyncStorage.setItem(SERVER_URL_KEY, url);
  current = url;
  return url;
}

export async function clearServerUrl(): Promise<void> {
  await AsyncStorage.removeItem(SERVER_URL_KEY);
  current = null;
}

/** Test helper. */
export function __setServerUrlForTests(url: string | null) {
  current = url;
}
