/** Pure logic of the GitHub-Releases self-updater (no RN imports, unit-tested). */
export interface LatestInfo {
  version: string;
  build: number;
  apk: string;
  notes: string;
  sha256: string;
  md5: string;
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** latest.json -> validated LatestInfo, or null on anything malformed (never throw into the UI). */
export function parseLatest(raw: unknown): LatestInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const build = Number(o.build);
  // apk must be a bare asset name: it is matched against the release's asset list, never used as a path/URL.
  if (!Number.isInteger(build) || build < 1 || typeof o.version !== 'string' || typeof o.apk !== 'string' || /[\/]/.test(o.apk) || !o.apk) return null;
  if (typeof o.md5 !== 'string' || !/^[0-9a-f]{32}$/i.test(o.md5)) return null;
  return {
    version: o.version,
    build,
    apk: o.apk,
    notes: typeof o.notes === 'string' ? o.notes : '',
    sha256: typeof o.sha256 === 'string' ? o.sha256 : '',
    md5: o.md5.toLowerCase(),
  };
}

export const isNewerBuild = (latest: LatestInfo, currentBuild: number): boolean => latest.build > currentBuild;

/** Throttle: check when never checked, clock went backwards, or the interval elapsed. */
export const dueForCheck = (lastMs: number | null, nowMs: number, intervalMs = CHECK_INTERVAL_MS): boolean =>
  lastMs == null || !Number.isFinite(lastMs) || nowMs < lastMs || nowMs - lastMs >= intervalMs;
