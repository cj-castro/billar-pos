import type { CashSession } from '../../../domain/types';
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
