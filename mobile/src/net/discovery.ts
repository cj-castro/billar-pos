import Constants from 'expo-constants';
import { getIpAddressAsync } from 'expo-network';
import { DEFAULT_PORT, loadServerUrl, saveServerUrl } from '../config/serverConfig';

const SCAN_CONCURRENCY = 32;

/** True iff GET {url}/api/v1/health answers 200 with a JSON `status` (any value: legacy backends send only that). */
export async function probe(url: string, timeoutMs = 400): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/v1/health`, { signal: ctl.signal });
    if (res.status !== 200) return false;
    const body = await res.json();
    return !!body && typeof body === 'object' && 'status' in body;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** /24 neighbours of a private IPv4 (192.168/16, 172.16/12, 10/8); [] otherwise. ponytail: assumes /24, add netmask math if a venue uses wider. */
function subnetHosts(ip: string): string[] {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return [];
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return [];
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) if (String(i) !== m[4]) hosts.push(`http://${m[1]}.${m[2]}.${m[3]}.${i}:${DEFAULT_PORT}`);
  return hosts;
}

/** Last-good, then build-time candidates, then a LAN scan. Returns the base URL (persisted as the new last-good) or null. */
export async function discoverServer(opts: { persist?: boolean } = {}): Promise<string | null> {
  const win = async (url: string | null) => {
    if (url && opts.persist !== false) await saveServerUrl(url);
    return url;
  };
  const extra = Constants.expoConfig?.extra as { serverCandidates?: string[] } | undefined;
  const ordered = [...new Set([await loadServerUrl(), ...(extra?.serverCandidates ?? [])])].filter((u): u is string => !!u);
  const ok = await Promise.all(ordered.map((u) => probe(u)));
  const hit = ordered.find((_, i) => ok[i]);
  if (hit) return win(hit);

  let ip = '';
  try {
    ip = await getIpAddressAsync();
  } catch {
    /* no network */
  }
  const hosts = subnetHosts(ip).filter((h) => !ordered.includes(h));
  let found: string | null = null;
  let next = 0;
  const worker = async () => {
    while (!found && next < hosts.length) {
      const h = hosts[next++];
      if (await probe(h)) found ??= h;
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  return win(found);
}
