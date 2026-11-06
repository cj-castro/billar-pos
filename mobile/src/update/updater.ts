import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { APP_BUILD } from '../config/version';
import { dueForCheck, isNewerBuild, parseLatest, type LatestInfo } from './updateModel';

/** Android-only self-update from a private GitHub Releases repo. Everything is a no-op when the build-time token is empty or on iOS. */
export interface FoundUpdate extends LatestInfo {
  /** GitHub API asset URL (private repo: browser_download_url does not work). */
  apkUrl: string;
}

const LAST_CHECK_KEY = 'update.lastCheck';
const API = 'https://api.github.com';
const cfg = () => (Constants.expoConfig?.extra as { updates?: { owner?: string; repo?: string; token?: string } } | undefined)?.updates;

export const updatesConfigured = (): boolean => {
  const c = cfg();
  return Platform.OS === 'android' && !!(c?.owner && c.repo && c.token);
};

const authHeaders = (accept: string) => ({ Authorization: `Bearer ${cfg()?.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' });

async function getJson(url: string, accept: string): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: authHeaders(accept), signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Returns the newer release, or null (up to date / not configured / throttled when !force). Throws on network/parse errors. */
export async function checkForUpdate(force: boolean): Promise<FoundUpdate | null> {
  if (!updatesConfigured()) return null;
  const last = Number(await AsyncStorage.getItem(LAST_CHECK_KEY)) || null;
  if (!force && !dueForCheck(last, Date.now())) return null;
  const { owner, repo } = cfg()!;
  const rel = (await getJson(`${API}/repos/${owner}/${repo}/releases/latest`, 'application/vnd.github+json')) as { assets?: { name: string; url: string }[] };
  const assets = rel.assets ?? [];
  const meta = assets.find((a) => a.name === 'latest.json');
  if (!meta) throw new Error('latest.json missing');
  const latest = parseLatest(await getJson(meta.url, 'application/octet-stream'));
  const apk = latest && assets.find((a) => a.name === latest.apk);
  if (!latest || !apk) throw new Error('bad latest.json');
  await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now())); // only after a successful check, so failures retry next start
  return isNewerBuild(latest, APP_BUILD) ? { ...latest, apkUrl: apk.url } : null;
}

const FLAG_GRANT_READ_URI_PERMISSION = 1;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

/** Download (with progress 0..1), verify md5, hand the APK to the system installer. Throws on any failure. */
export async function downloadAndInstall(u: FoundUpdate, onProgress: (p: number) => void): Promise<void> {
  const FS = await import('expo-file-system/legacy');
  const IL = await import('expo-intent-launcher');
  const dest = `${FS.cacheDirectory}${u.apk}`;
  await FS.deleteAsync(dest, { idempotent: true });
  const dl = FS.createDownloadResumable(u.apkUrl, dest, { headers: authHeaders('application/octet-stream') }, (p) =>
    onProgress(p.totalBytesExpectedToWrite > 0 ? p.totalBytesWritten / p.totalBytesExpectedToWrite : 0),
  );
  const res = await dl.downloadAsync();
  if (res?.status !== 200) throw new Error(`download HTTP ${res?.status}`);
  // ponytail: expo-crypto cannot hash files, so the device verifies md5 (FileSystem.getInfoAsync); sha256 in latest.json is for humans/audit.
  // Integrity vs. accidental corruption only: authenticity comes from Android's APK signature check (same keystore) at install time.
  const info = await FS.getInfoAsync(dest, { md5: true });
  if (!info.exists || info.md5?.toLowerCase() !== u.md5) {
    await FS.deleteAsync(dest, { idempotent: true });
    throw new Error('md5 mismatch');
  }
  await IL.startActivityAsync('android.intent.action.VIEW', {
    data: await FS.getContentUriAsync(dest),
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}
