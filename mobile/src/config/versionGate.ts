/** Pure semver helpers for the min-version gate (health `min_mobile_version`). Pre-release tags are ignored. */
export function parseSemver(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/** -1 / 0 / 1; null when either side is unparseable. */
export function compareSemver(a: unknown, b: unknown): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/** True only when the server states a valid minimum and `current` is older. Absent/garbage minimum never blocks. */
export const isBelowMin = (min: unknown, current: string): boolean => compareSemver(current, min) === -1;
