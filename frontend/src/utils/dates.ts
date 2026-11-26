/**
 * Calendar dates in the BAR's timezone — the one place pages get "today".
 *
 * `new Date().toISOString().slice(0, 10)` is a UTC date: after 18:00 in Mexico
 * it is already "tomorrow", so a page defaulting to "today" showed $0 for most of
 * the night and month-to-date ranges skipped the current day. Every report page
 * must build its date range with these helpers instead.
 *
 */
import { getVenue } from './venue'

/** The venue's timezone (Ajustes → Negocio; default America/Mexico_City). */
export function businessTz(): string { return getVenue().timezone }

/** YYYY-MM-DD for `d` as seen on the bar's wall clock. */
export function localDate(d: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD
  return d.toLocaleDateString('en-CA', { timeZone: businessTz() })
}

/** "YYYY-MM-DDTHH:mm" on the bar's wall clock, for <input type="datetime-local">.
 *  The server reads a naive value as bar-local time (batch E7). */
export function localDateTimeInput(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTz(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** Today's BUSINESS day in the bar's timezone: before the closing hour
 *  (Ajustes → Negocio, e.g. 06:00) it is still the previous night's date. */
export function localToday(): string {
  const [h, m] = (getVenue().day_cutoff || '00:00').split(':').map(Number)
  return localDate(new Date(Date.now() - (h * 60 + m) * 60_000))
}

/** The bar-local calendar date `n` days before today. */
export function localDaysAgo(n: number): string {
  const [y, m, d] = localToday().split('-').map(Number)
  // Pure calendar arithmetic on the local date (noon UTC avoids any DST edge).
  const t = new Date(Date.UTC(y, m - 1, d, 12))
  t.setUTCDate(t.getUTCDate() - n)
  return t.toISOString().slice(0, 10)
}

/** First day of the current month in the bar's timezone. */
export function localFirstOfMonth(): string {
  return localToday().slice(0, 8) + '01'
}

/** Monday of the current week, bar time. */
export function localStartOfWeek(): string {
  const [y, m, d] = localToday().split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d, 12))
  const iso = (t.getUTCDay() + 6) % 7          // 0 = Monday
  t.setUTCDate(t.getUTCDate() - iso)
  return t.toISOString().slice(0, 10)
}

/** [first, last] day of the previous month, bar time. */
export function localPreviousMonth(): [string, string] {
  const [y, m] = localToday().split('-').map(Number)
  const first = new Date(Date.UTC(m === 1 ? y - 1 : y, (m + 10) % 12, 1, 12))
  const last = new Date(Date.UTC(y, m - 1, 0, 12))   // day 0 of this month = last of previous
  return [first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]
}

export type RangePreset = 'hoy' | 'ayer' | 'semana' | 'mes' | 'mes_pasado' | '7d' | '30d' | '90d'

/** The [from, to] a preset means right now. */
export function presetRange(p: RangePreset): [string, string] {
  switch (p) {
    case 'hoy': return [localToday(), localToday()]
    case 'ayer': return [localDaysAgo(1), localDaysAgo(1)]
    case 'semana': return [localStartOfWeek(), localToday()]
    case 'mes': return [localFirstOfMonth(), localToday()]
    case 'mes_pasado': return localPreviousMonth()
    case '7d': return [localDaysAgo(6), localToday()]
    case '30d': return [localDaysAgo(29), localToday()]
    case '90d': return [localDaysAgo(89), localToday()]
  }
}
