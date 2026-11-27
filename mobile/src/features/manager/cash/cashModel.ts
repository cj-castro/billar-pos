import type { CashSession } from '../../../domain/types';
import { formatMXN } from '../../../utils/money';
import { applyPadKey } from '../../waiter/pay/payModel';

export { applyPadKey };

/** counted - expected (same sign as the server's cash_over_short_cents): >0 sobrante, <0 faltante. */
export const cashDifference = (countedCents: number, expectedCents: number) => countedCents - expectedCents;

export type DiffTone = 'ok' | 'over' | 'short';
export const diffTone = (diff: number): DiffTone => (diff === 0 ? 'ok' : diff > 0 ? 'over' : 'short');

/** The count is mandatory to close (0 is a valid count only when the user typed it; the pad starts at 0 so we require a touch). */
export function canClose(counted: number | null): boolean {
  return counted != null && counted >= 0;
}

export interface ExpenseForm {
  description: string;
  payee: string;
  amountCents: number;
  method: 'CASH' | 'CARD';
}

export type ExpenseError = 'description' | 'payee' | 'amount';
/** First missing field, or null when the form can be submitted. */
export function validateExpense(f: ExpenseForm): ExpenseError | null {
  if (!f.description.trim()) return 'description';
  if (!f.payee.trim()) return 'payee';
  if (!(f.amountCents > 0)) return 'amount';
  return null;
}

export const expenseBody = (f: ExpenseForm) => ({ amount_cents: f.amountCents, payee: f.payee.trim(), description: f.description.trim(), payment_method: f.method });

/** Server 409 OPEN_TICKETS: the count is only inside the Spanish sentence ("hay 3 cuentas abiertas"). */
export function openTicketsCount(message: string | undefined, fallback: number | null): number | null {
  const m = message?.match(/hay\s+(\d+)/i);
  return m ? Number(m[1]) : fallback;
}

/** Sessions history: newest first, at most 30 (what the endpoint returns). */
export const recentSessions = (s: readonly CashSession[]) => [...s].sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? '')).slice(0, 30);

// ---- Count by denomination (flag cash.count_by_denomination). Mirrors frontend/src/utils/cashCount.ts. ----

export interface Denom {
  key: string; // 'B1000', 'C0.50', ...
  cents: number; // face value in cents
  kind: string; // 'BILL' | 'COIN'
}
/** {denomination key: quantity}. Missing key = 0. */
export type CountLines = Record<string, number>;
export interface CountLine {
  key: string;
  qty: number;
}

/** Total in cents of a count. Keys not in `denoms` count as 0. */
export function totalCents(lines: CountLines, denoms: readonly Denom[]): number {
  let total = 0;
  for (const d of denoms) total += (lines[d.key] || 0) * d.cents;
  return total;
}

/** Envelope = counted - left, per key. Zero rows are dropped. */
export function splitEnvelope(counted: CountLines, left: CountLines): CountLines {
  const out: CountLines = {};
  for (const k of new Set([...Object.keys(counted), ...Object.keys(left)])) {
    const q = (counted[k] || 0) - (left[k] || 0);
    if (q !== 0) out[k] = q;
  }
  return out;
}

/** The first key where left is more than counted, or null. */
export function leftExceedsKey(counted: CountLines, left: CountLines): string | null {
  for (const k of Object.keys(left)) if ((left[k] || 0) > (counted[k] || 0)) return k;
  return null;
}

/** Lower each row of `lines` to at most `max[key]`. Returns the same object when nothing changed. */
export function clampTo(lines: CountLines, max: CountLines): CountLines {
  let changed = false;
  const out: CountLines = {};
  for (const k of Object.keys(lines)) {
    const q = Math.min(lines[k] || 0, max[k] || 0);
    if (q !== lines[k]) changed = true;
    if (q > 0) out[k] = q;
  }
  return changed ? out : lines;
}

/** API body rows: [{key, qty}] with whole qty > 0 only. */
export function toApi(lines: CountLines): CountLine[] {
  return Object.entries(lines)
    .filter(([, q]) => Number.isInteger(q) && q > 0)
    .map(([key, qty]) => ({ key, qty }));
}

/** Typed text -> whole quantity >= 0, or null when it is not a whole number. Empty is 0. */
export function parseQty(text: string): number | null {
  const t = text.trim();
  if (!t) return 0;
  if (!/^\d+$/.test(t)) return null;
  return parseInt(t.slice(0, 7), 10);
}

/** Close step 2 check: what stays can not exceed what was counted; a note is required when what stays differs from the fund target. */
export function canCloseCounted(
  counted: CountLines,
  left: CountLines,
  fundTarget: number,
  note: string,
  denoms: readonly Denom[],
): { ok: boolean; reason?: 'LEFT_EXCEEDS' | 'NOTE_REQUIRED' } {
  if (leftExceedsKey(counted, left) != null) return { ok: false, reason: 'LEFT_EXCEEDS' };
  if (totalCents(left, denoms) !== fundTarget && !note.trim()) return { ok: false, reason: 'NOTE_REQUIRED' };
  return { ok: true };
}

/** Row label value: 100000 -> "$1,000"; 50 -> "$0.50". */
export function denomValue(cents: number): string {
  const s = formatMXN(cents);
  return cents % 100 === 0 ? s.replace(/\.00$/, '') : s;
}
