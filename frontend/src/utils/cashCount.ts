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

/** What should stay in the drawer: the fund, or everything when the drawer
 *  holds less than the fund. Card tips are paid in cash from the drawer, so a
 *  slow or card-heavy night can leave less than the fund; then everything
 *  stays and the envelope is empty. The server applies the same rule to
 *  decide when a note is required. */
export function shouldStayCents(countedTotal: number, fundTarget: number): number {
  return Math.min(fundTarget, countedTotal)
}

function gcd(a: number, b: number): number { return b ? gcd(b, a % b) : a }

/** Best combination of the counted pieces that adds up to `target` exactly,
 *  or as close BELOW it as the pieces allow, never more pieces of a row than
 *  were counted. `prefer` breaks ties between combinations of the same amount:
 *  'most' pieces keeps coins and small bills (good for the drawer fund, which
 *  needs change), 'fewest' uses big bills first (good for paying tips, so the
 *  coins stay in the drawer). Bounded knapsack over the target in units of the
 *  smallest common step (50 cents for MXN): about 12 x 4,000 cells for $2,000. */
export function pickPieces(counted: CountLines, denoms: Denom[], target: number,
                           prefer: 'most' | 'fewest'): CountLines {
  const items = denoms.filter(d => (counted[d.key] || 0) > 0 && d.cents > 0)
  if (target <= 0 || items.length === 0) return {}
  const unit = items.reduce((g, d) => gcd(g, d.cents), 0)
  const T = Math.floor(target / unit)
  const NONE = -1
  const better = (a: number, b: number) => b === NONE || (prefer === 'most' ? a > b : a < b)
  let best = new Int32Array(T + 1).fill(NONE)   // pieces used to make exactly s units
  best[0] = 0
  const takes: Int32Array[] = []
  for (const d of items) {
    const v = d.cents / unit
    const c = counted[d.key]
    const next = new Int32Array(T + 1).fill(NONE)
    const take = new Int32Array(T + 1)
    for (let s = 0; s <= T; s++) {
      const maxQ = Math.min(c, Math.floor(s / v))
      for (let q = 0; q <= maxQ; q++) {
        const prev = best[s - q * v]
        if (prev !== NONE && better(prev + q, next[s])) { next[s] = prev + q; take[s] = q }
      }
    }
    best = next
    takes.push(take)
  }
  let s = T
  while (s > 0 && best[s] === NONE) s--
  const out: CountLines = {}
  for (let i = items.length - 1; i >= 0; i--) {
    const q = takes[i][s]
    if (q > 0) out[items[i].key] = q
    s -= q * (items[i].cents / unit)
  }
  return out
}

function allOf(counted: CountLines, denoms: Denom[]): CountLines {
  const all: CountLines = {}
  for (const d of denoms) if ((counted[d.key] || 0) > 0) all[d.key] = counted[d.key]
  return all
}

/** Suggest what stays in the drawer: everything when the count is at or below
 *  the fund, else the fund made with as many pieces as possible (coins and
 *  small bills stay for change; big bills go to the envelope). */
export function suggestLeft(counted: CountLines, denoms: Denom[], fundTarget: number): CountLines {
  if (totalCents(counted, denoms) <= fundTarget) return allOf(counted, denoms)
  return pickPieces(counted, denoms, fundTarget, 'most')
}

/** Tips are paid in cash from the drawer (card tips too). The manager counts
 *  the whole drawer BEFORE paying them; the POS picks the pieces to pay them
 *  with (fewest pieces, big bills first) and what is left is the close count.
 *  `paid` can be below `tips` when the drawer cannot cover them, or by the few
 *  centavos the coins cannot make (tips are not always a multiple of 50 cents). */
export function payTips(counted: CountLines, denoms: Denom[], tipCents: number):
    { tipLines: CountLines; paid: number; after: CountLines } {
  const tipLines = totalCents(counted, denoms) <= tipCents
    ? allOf(counted, denoms)
    : pickPieces(counted, denoms, tipCents, 'fewest')
  return { tipLines, paid: totalCents(tipLines, denoms), after: splitEnvelope(counted, tipLines) }
}
