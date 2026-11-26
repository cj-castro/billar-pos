/** Mexico City has been UTC-6 all year since Oct 2022 (no DST), so the venue day is a fixed shift. */
const OFFSET_MS = -6 * 3600_000;

/** YYYY-MM-DD of the venue calendar day for an instant (ms, ISO or Date). */
export function mexicoDay(at: number | string | Date): string {
  const ms = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : new Date(at).getTime();
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 10);
}

/** True when the ISO timestamp falls on the same venue day as `nowMs`. */
export function isMexicoToday(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return !Number.isNaN(t) && mexicoDay(t) === mexicoDay(nowMs);
}

/** "HH:MM" on the venue clock. */
export function mexicoClock(iso: string | null | undefined): string {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? '' : new Date(t + OFFSET_MS).toISOString().slice(11, 16);
}
