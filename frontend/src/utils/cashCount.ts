/**
 * Cash drawer count by denomination (bills and coins). Pure helpers, no React.
 *
 * Money is integer cents. A count is a map {denomination key: quantity},
 * e.g. {B500: 3, C10: 7}. The denomination table comes from GET /cash/status
 * (`denominations`), in display order; the server is the source of truth and
 * re-checks every count.
 */
import { formatMXN } from './money'

export interface Denom {
  key: string     // 'B1000', 'C0.50', ...
  cents: number   // face value in cents
  kind: string    // 'BILL' | 'COIN'
}

/** {denomination key: quantity}. Missing key = 0. */
export type CountLines = Record<string, number>

/** One row as the API sends and receives it. */
export interface CountLine { key: string; qty: number }

/** POST /cash/close response when the close had a count (Task 3). */
export interface CloseEnvelope { number: number; declared_cents: number; lines: CountLine[] }
export interface DrawerLeftSlip { total_cents: number; lines: CountLine[] }
export interface CloseResponse {
  session: any
  summary: any
  envelope?: CloseEnvelope
  /** For the "Queda en caja" slip that goes INTO the envelope. Print only; never show on screen. */
  slip_drawer_left?: DrawerLeftSlip
  /** ADMIN only. */
  drawer_left?: DrawerLeftSlip
}

/** Total in cents of a count. Keys that are not in `denoms` count as 0. */
export function totalCents(lines: CountLines, denoms: Denom[]): number {
  let total = 0
  for (const d of denoms) total += (lines[d.key] || 0) * d.cents
  return total
}

/** Envelope = counted − left, per key. Zero rows are dropped. A row where
 *  left is more than counted gives a negative quantity: check with
 *  `leftExceedsKey` first (the server refuses it with LEFT_EXCEEDS_COUNTED). */
export function splitEnvelope(counted: CountLines, left: CountLines): CountLines {
  const out: CountLines = {}
  const keys = new Set([...Object.keys(counted), ...Object.keys(left)])
  for (const k of keys) {
    const q = (counted[k] || 0) - (left[k] || 0)
    if (q !== 0) out[k] = q
  }
  return out
}

/** The first key where left is more than counted, or null. */
export function leftExceedsKey(counted: CountLines, left: CountLines): string | null {
  for (const k of Object.keys(left)) {
    if ((left[k] || 0) > (counted[k] || 0)) return k
  }
  return null
}

/** Lower each row of `lines` to at most `max[key]` (used when the counted
 *  grid changes after the "stays in drawer" grid was filled). */
export function clampTo(lines: CountLines, max: CountLines): CountLines {
  let changed = false
  const out: CountLines = {}
  for (const k of Object.keys(lines)) {
    const q = Math.min(lines[k] || 0, max[k] || 0)
    if (q !== lines[k]) changed = true
    if (q > 0) out[k] = q
  }
  return changed ? out : lines
}

/** API body rows: [{key, qty}] with qty > 0 only. */
export function toApi(lines: CountLines): CountLine[] {
  return Object.entries(lines)
    .filter(([, q]) => Number.isInteger(q) && q > 0)
    .map(([key, qty]) => ({ key, qty }))
}

/** Typed text -> whole quantity >= 0, or null when the text is not a whole
 *  number (e.g. "1.5", "2,5", "-3", "abc"). The caller keeps the previous value
 *  on null. Empty text is 0. */
export function parseQty(text: string): number | null {
  const t = text.trim()
  if (!t) return 0
  if (!/^\d+$/.test(t)) return null
  // Seven digits is already far above any real drawer; the server refuses
  // more than 1,000,000 per row (TOO_LARGE).
  return parseInt(t.slice(0, 7), 10)
}

/** Face value for a row label: 100000 -> "$1,000"; 50 -> "$0.50". */
export function denomLabel(cents: number): string {
  const s = formatMXN(cents)
  return cents % 100 === 0 ? s.replace(/[.,]00(?=\D*$)/, '') : s
}
