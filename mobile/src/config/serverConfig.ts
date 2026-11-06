import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';

export const SERVER_URL_KEY = 'bola8.serverUrl';
export const HEALTH_TIMEOUT_MS = 5000;

let current: string | null = null;
const urlListeners = new Set<(url: string | null) => void>();

/** Subscribe to server-URL changes (reachability probe re-targets the new host). */
export function onServerUrlChange(cb: (url: string | null) => void): () => void {
  urlListeners.add(cb);
  return () => {
    urlListeners.delete(cb);
  };
}
const notifyUrl = () => urlListeners.forEach((cb) => cb(current));

/**
 * "192.168.1.22:8080" -> "http://192.168.1.22:8080". Strips whitespace, trailing slashes and a
 * pasted "/api/v1" suffix. Returns null when the input cannot be a base URL.
 * (Regex rather than `URL`: Hermes' URL polyfill is partial.)
 */
export const DEFAULT_PORT = 8080;

/** SEC-03: http:// only for private/LAN hosts (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, localhost, *.local, 10.0.2.2). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Why a URL is not acceptable (null = fine). 'insecure' = cleartext http:// to a non-LAN host. */
export function serverUrlProblem(input: string): 'invalid' | 'insecure' | null {
  const url = normalizeServerUrl(input);
  if (!url) return 'invalid';
  const m = /^(https?):\/\/([^:/]+)/.exec(url)!;
  return m[1] === 'http' && !isPrivateHost(m[2]) ? 'insecure' : null;
}

export function normalizeServerUrl(input: string): string | null {
  let s = (input ?? '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  s = s.replace(/\/+$/, '').replace(/\/api(\/v1)?$/i, '').replace(/\/+$/, '');
  const m = /^(https?):\/\/([^\s/?#:@]+)(?::(\d{1,5}))?$/i.exec(s);
  if (!m) return null;
  if (m[3] && Number(m[3]) > 65535) return null;
  const scheme = m[1].toLowerCase();
  // F3: a bare http host means the POS nginx on :8080; https keeps 443 (explicit ports always win).
  const port = m[3] ?? (scheme === 'http' ? String(DEFAULT_PORT) : '');
  return `${scheme}://${m[2].toLowerCase()}${port ? `:${port}` : ''}`;
}

export type ServerCheck =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'insecure' | 'timeout' | 'unreachable' | 'not_pos' };

/** GET {base}/api/v1/health expecting {status:"ok"}; 5 s timeout. */
export async function validateServer(base: string): Promise<ServerCheck> {
  const url = normalizeServerUrl(base);
  if (!url) return { ok: false, reason: 'invalid' };
  if (serverUrlProblem(url) === 'insecure') return { ok: false, reason: 'insecure' };
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
  if (!url || serverUrlProblem(url)) throw new Error('INVALID_SERVER_URL');
  await AsyncStorage.setItem(SERVER_URL_KEY, url);
  const changed = current !== url;
  current = url;
  if (changed) notifyUrl();
  return url;
}

export async function clearServerUrl(): Promise<void> {
  await AsyncStorage.removeItem(SERVER_URL_KEY);
  current = null;
  notifyUrl();
}

/** Test helper. */
export function __setServerUrlForTests(url: string | null) {
  current = url;
}
