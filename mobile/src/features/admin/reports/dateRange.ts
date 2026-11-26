/** Pure date helpers for Reportes. All dates are Mexico-local YYYY-MM-DD strings (never UTC: API_CONTRACTS gotcha 6). */
export type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'range';
export interface DateRange {
  from: string;
  to: string;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MX = 'America/Mexico_City';

export function mexicoToday(now: Date = new Date()): string {
  let s = '';
  try {
    s = now.toLocaleDateString('en-CA', { timeZone: MX });
  } catch {
    // fall through to the fixed-offset fallback
  }
  // ponytail: Mexico has no DST since 2022 (UTC-6); fallback only when Hermes Intl lacks the zone.
  return YMD.test(s) ? s : new Date(now.getTime() - 6 * 3600_000).toISOString().slice(0, 10);
}

const toUtc = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(ymd: string, n: number): string {
  const d = toUtc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
}

export function isValidYmd(s: string): boolean {
  if (!YMD.test(s)) return false;
  return fmt(toUtc(s)) === s; // rejects 2026-02-31
}

/** `custom` only matters for 'range'; an invalid/inverted custom range falls back to today. */
export function rangeFor(preset: Preset, today: string, custom?: DateRange): DateRange {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case 'week': {
      const dow = (toUtc(today).getUTCDay() + 6) % 7; // Monday = 0
      return { from: addDays(today, -dow), to: today };
    }
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'range':
      return custom && isValidYmd(custom.from) && isValidYmd(custom.to) && custom.from <= custom.to ? custom : { from: today, to: today };
  }
}
