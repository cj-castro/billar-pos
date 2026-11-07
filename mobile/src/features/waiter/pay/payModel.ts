/** Pure Cobrar logic (DESIGN_SPEC_V2 §2.7). All amounts are integer cents. */
export type Method = 'CASH' | 'CARD' | 'MIXTO' | 'EXTERNAL';
export type TipChoice = { kind: 'none' } | { kind: 'pct'; pct: 10 | 15 | 20 } | { kind: 'custom'; cents: number };
/** Mixto: the side the user typed last is authoritative, the other one auto-fills with the remainder. */
export interface PayState {
  tip: TipChoice;
  method: Method;
  cashCents: number;
  cardCents: number;
  last: 'cash' | 'card' | null;
}

export const initialPay = (delivery: boolean): PayState => ({ tip: { kind: 'none' }, method: delivery ? 'EXTERNAL' : 'CASH', cashCents: 0, cardCents: 0, last: null });

export function tipCents(total: number, tip: TipChoice): number {
  if (tip.kind === 'pct') return Math.round((total * tip.pct) / 100);
  if (tip.kind === 'custom') return Math.max(0, tip.cents);
  return 0;
}

export type PayReason = 'cashLow' | 'mixedLow' | 'mixedParts' | null;

export interface PayView {
  tip: number;
  due: number;
  cash: number;
  card: number;
  /** Change handed back (cash part only). */
  change: number;
  valid: boolean;
  reason: PayReason;
  /** Cents missing, for the reason string. */
  short: number;
}

export function derive(total: number, s: PayState): PayView {
  const tip = s.method === 'EXTERNAL' ? 0 : tipCents(total, s.tip);
  const due = total + tip;
  const v = { tip, due, cash: 0, card: 0, change: 0, valid: true, reason: null as PayReason, short: 0 };
  if (s.method === 'CASH') {
    v.cash = s.cashCents;
    v.change = Math.max(0, s.cashCents - due);
    v.short = Math.max(0, due - s.cashCents);
    if (v.short > 0) return { ...v, valid: false, reason: 'cashLow' };
  } else if (s.method === 'CARD') {
    v.card = due;
  } else if (s.method === 'MIXTO') {
    if (s.last === 'card') {
      v.card = s.cardCents;
      v.cash = Math.max(0, due - s.cardCents);
    } else if (s.last === 'cash') {
      v.cash = s.cashCents;
      v.card = Math.max(0, due - s.cashCents);
    }
    if (v.cash <= 0 || v.card <= 0) return { ...v, valid: false, reason: 'mixedParts' };
    const sum = v.cash + v.card;
    v.short = Math.max(0, due - sum);
    if (v.short > 0) return { ...v, valid: false, reason: 'mixedLow' };
    v.change = sum - due;
    if (v.change > v.cash) return { ...v, valid: false, reason: 'mixedLow' }; // change must come out of the cash part
  }
  return v;
}

/** Cash chips: exact, then the next 50/100/200/500 pesos above `due`, de-duplicated. */
export function cashChips(due: number): number[] {
  const out = [due];
  for (const step of [5000, 10000, 20000, 50000]) {
    const v = Math.ceil(due / step) * step;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export type PadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '00' | 'back';
const MAX_PESOS = 1_000_000;
/** Numpad edits whole pesos; returns the new amount in cents. */
export function applyPadKey(cents: number, key: PadKey): number {
  const pesos = Math.floor(cents / 100);
  const next = key === 'back' ? Math.floor(pesos / 10) : key === '00' ? pesos * 100 : pesos * 10 + Number(key);
  return Math.min(MAX_PESOS, next) * 100;
}

/** Edit one Mixto part; the other auto-fills (see PayState.last). */
export const setPart = (s: PayState, side: 'cash' | 'card', cents: number): PayState => ({ ...s, [side === 'cash' ? 'cashCents' : 'cardCents']: cents, last: side });

export interface CloseBody {
  payment_type: 'CASH' | 'CARD' | 'EXTERNAL';
  payment_type_2?: 'CARD';
  tendered_cents?: number;
  tendered_cents_2?: number;
  tip_cents: number;
  tip_source?: 'CASH' | 'CARD' | 'SPLIT';
  tip_cash_cents?: number;
  tip_card_cents?: number;
  expected_total_cents: number;
  /** Only after a 403 PIN_REQUIRED. */
  manager_pin?: string;
}

export function buildCloseBody(total: number, s: PayState): CloseBody {
  const v = derive(total, s);
  const base = { tip_cents: v.tip, expected_total_cents: total };
  switch (s.method) {
    case 'CASH':
      return { ...base, payment_type: 'CASH', tendered_cents: v.cash, tip_source: 'CASH' };
    case 'CARD':
      return { ...base, payment_type: 'CARD', tip_source: 'CARD' };
    case 'EXTERNAL':
      return { ...base, payment_type: 'EXTERNAL' };
    case 'MIXTO': {
      // Tip split proportional to what each tender covers; the card side takes the rounding remainder so they sum.
      const tipCash = Math.round((v.tip * v.cash) / (v.cash + v.card));
      return {
        ...base,
        payment_type: 'CASH',
        payment_type_2: 'CARD',
        tendered_cents: v.cash,
        tendered_cents_2: v.card,
        tip_source: 'SPLIT',
        tip_cash_cents: tipCash,
        tip_card_cents: v.tip - tipCash,
      };
    }
  }
}

export type CloseErrorKind = 'insufficient' | 'notOpen' | 'conflict' | 'pin' | 'barClosed' | 'pinLocked' | 'other';
/** TICKET_NOT_OPEN is an ERROR (only HTTP 200 is success). Backend sends INSUFFICIENT_PAYMENT, or AMOUNT_MISMATCH when the request carries an Idempotency-Key. */
export function classifyCloseError(e: { status: number | null; code: string }): CloseErrorKind {
  if (e.status === 422 && (e.code === 'INSUFFICIENT_PAYMENT' || e.code === 'AMOUNT_MISMATCH')) return 'insufficient';
  if (e.status === 409 && e.code === 'TICKET_NOT_OPEN') return 'notOpen';
  if (e.status === 409 && (e.code === 'VERSION_CONFLICT' || e.code === 'TICKET_VERSION' || e.code === 'TOTAL_MISMATCH')) return 'conflict';
  if (e.status === 403 && e.code === 'PIN_REQUIRED') return 'pin';
  if (e.status === 403 && e.code === 'BAR_CLOSED') return 'barClosed';
  if (e.status === 429 && e.code === 'PIN_LOCKED') return 'pinLocked';
  return 'other';
}
