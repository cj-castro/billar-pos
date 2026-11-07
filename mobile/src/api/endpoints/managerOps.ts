import client from '../client';
import type { Ticket } from '../../domain/types';

/** Payment fields of a ticket that the base `Ticket` type does not declare. */
export interface PaymentFields {
  payment_type: string | null;
  payment_type_2?: string | null;
  tendered_cents: number | null;
  tendered_cents_2?: number | null;
  tip_cents: number | null;
  tip_source?: string | null;
  tip_cash_cents?: number | null;
  tip_card_cents?: number | null;
  edited_after_close?: boolean;
}

export interface TimerSession {
  id: string;
  status: string;
  start_time: string | null;
  end_time: string | null;
  duration_seconds?: number | null;
  charge_cents?: number | null;
}

export interface PromoOffer {
  promotion_id: string;
  name: string;
  promo_type: string;
  discount_cents: number;
  free_pool_minutes?: number;
}

export interface EditHistoryRow {
  id: string;
  user_id: string | null;
  action: string;
  reason: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

/** 409 TICKET_NOT_OPEN. `reason` required. */
export async function forceClose(ticketId: string, reason: string): Promise<Ticket> {
  const { data } = await client.post<Ticket>(`/tickets/${ticketId}/force-close`, { reason });
  return data;
}

/** 409 ALREADY_OPEN | CASH_SESSION_CLOSED | RESOURCE_UNAVAILABLE | RESOURCE_OCCUPIED. */
export async function reopenTicket(ticketId: string, reason?: string): Promise<Ticket> {
  const { data } = await client.post<Ticket>(`/tickets/${ticketId}/reopen`, reason ? { reason } : {});
  return data;
}

/** PIN-gated (401 INVALID_PIN, 429 rate limit). 422 REASON_REQUIRED | NO_CHANGES, 409 TICKET_NOT_CLOSED. */
export async function editPayment(ticketId: string, body: Record<string, unknown>, pin: string, reason: string): Promise<Ticket> {
  const { data } = await client.post<Ticket>(`/tickets/${ticketId}/edit-payment`, { ...body, pin, reason });
  return data;
}

export async function getEditHistory(ticketId: string): Promise<EditHistoryRow[]> {
  const { data } = await client.get<EditHistoryRow[]>(`/tickets/${ticketId}/edit-history`);
  return data;
}

/** 404 PROMO_NOT_FOUND, 409 PROMO_NOT_CONFIRMABLE. */
export async function decidePromotion(ticketId: string, promotionId: string, decision: 'ACCEPTED' | 'DECLINED'): Promise<Ticket> {
  const { data } = await client.post<Ticket>(`/tickets/${ticketId}/promotions/${promotionId}`, { decision });
  return data;
}

/** No PIN; the server checks `manager_id` is an active MANAGER/ADMIN. 503 when the print agent is down. */
export async function reprintTicket(ticketId: string, managerId: string): Promise<{ ok: boolean; job_id?: string }> {
  const { data } = await client.post<{ ok: boolean; job_id?: string }>(`/tickets/${ticketId}/reprint`, { manager_id: managerId });
  return data;
}

/** 404 NO_ACTIVE_TIMER. Without items the ticket CLOSES, with items it becomes EXPRESS. */
export async function voidTimer(ticketId: string): Promise<{ ok: boolean; ticket_closed: boolean; ticket?: Ticket }> {
  const { data } = await client.post<{ ok: boolean; ticket_closed: boolean; ticket?: Ticket }>(`/tickets/${ticketId}/void-timer`);
  return data;
}

/** Naive ISO strings are read by the server as venue-local time. 422 INVALID_TIMESTAMP | INVALID_TIME_RANGE. */
export async function editTimer(ticketId: string, sessionId: string, body: { start_time: string; end_time?: string; reason: string }): Promise<unknown> {
  const { data } = await client.patch(`/tickets/${ticketId}/timer/${sessionId}`, body);
  return data;
}

/** Void rows of one Mexico day (`from`=`to`=YYYY-MM-DD). */
export async function listVoids(day: string): Promise<unknown[]> {
  const { data } = await client.get<unknown[]>('/reports/voids', { params: { from: day, to: day } });
  return data;
}
