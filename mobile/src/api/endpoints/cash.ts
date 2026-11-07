import client, { toApiError } from '../client';
import type { CashSession, CashStatus } from '../../domain/types';

export async function getCashStatus(): Promise<CashStatus> {
  const { data } = await client.get<CashStatus>('/cash/status');
  return data;
}

export interface CashExpense {
  id: string;
  session_id: string;
  amount_cents: number;
  payment_method: 'CASH' | 'CARD';
  payee: string;
  description: string;
  created_by: string;
  created_at: string | null;
}

export interface TipDistribution {
  floor_pct: number;
  bar_pct: number;
  kitchen_pct: number;
  floor_cents?: number;
  bar_cents?: number;
  kitchen_cents?: number;
}

/** `cash_over_short_cents` / `closing_cash_counted_cents` are null until the session is closed. */
export interface CashSummary {
  ticket_count: number;
  total_sales_cents: number;
  total_tips_cents: number;
  cash_sales_cents: number;
  card_sales_cents: number;
  cash_tips_cents: number;
  card_tips_cents: number;
  total_expenses_cents: number;
  cash_expenses_cents: number;
  card_expenses_cents: number;
  tip_payout_cents: number;
  opening_fund_cents: number;
  expected_cash_cents: number;
  closing_cash_counted_cents: number | null;
  cash_over_short_cents: number | null;
  expenses: CashExpense[];
  tip_distribution: TipDistribution | null;
}

export interface CashSummaryResponse {
  session: CashSession;
  summary: CashSummary;
}

export interface SessionTicket {
  id: string;
  customer_name: string | null;
  resource_code: string | null;
  resource_type: string | null;
  status: string;
  payment_type: string | null;
  total_cents: number;
  tip_cents: number;
  closed_at: string | null;
  was_reopened: boolean;
}

/** Current session summary; `null` when no session is open (404 NO_OPEN_SESSION). */
export async function getCashSummary(): Promise<CashSummaryResponse | null> {
  try {
    const { data } = await client.get<CashSummaryResponse>('/cash/current/summary');
    return data;
  } catch (e) {
    if (toApiError(e).status === 404) return null;
    throw e;
  }
}

/** 409 SESSION_ALREADY_OPEN. */
export async function openCash(openingFundCents: number): Promise<CashSession> {
  const { data } = await client.post<CashSession>('/cash/open', { opening_fund_cents: openingFundCents });
  return data;
}

/** 409 OPEN_TICKETS (message carries the count), 404 NO_OPEN_SESSION. */
export async function closeCash(countedCents: number, notes?: string): Promise<CashSummaryResponse> {
  const { data } = await client.post<CashSummaryResponse>('/cash/close', { closing_cash_counted_cents: countedCents, notes: notes || null });
  return data;
}

export async function listSessionTickets(): Promise<SessionTicket[]> {
  const { data } = await client.get<SessionTicket[]>('/cash/current/tickets');
  return data;
}

export async function addExpense(body: { amount_cents: number; payee: string; description: string; payment_method: 'CASH' | 'CARD' }): Promise<CashExpense> {
  const { data } = await client.post<CashExpense>('/cash/current/expenses', body);
  return data;
}

export async function deleteExpense(id: string): Promise<void> {
  await client.delete(`/cash/expenses/${id}`);
}

export async function listCashSessions(): Promise<CashSession[]> {
  const { data } = await client.get<CashSession[]>('/cash/sessions');
  return data;
}

/** Closed-session summary (same shape as the current one). */
export async function getCashSessionSummary(id: string): Promise<CashSummaryResponse> {
  const { data } = await client.get<CashSummaryResponse>(`/cash/${id}/summary`);
  return data;
}
