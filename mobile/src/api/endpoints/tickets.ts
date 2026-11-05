import client from '../client';
import type { Ticket, TicketLineItem, TicketType } from '../../domain/types';

export async function getTicket(id: string): Promise<Ticket> {
  const { data } = await client.get<Ticket>(`/tickets/${id}`);
  return data;
}

export async function listTickets(params: { status?: string; resource_id?: string } = {}): Promise<Ticket[]> {
  const { data } = await client.get<Ticket[]>('/tickets', { params });
  return data;
}

export interface OpenTicketBody {
  resource_id?: string;
  ticket_type: TicketType;
  rappi_order_id?: string;
  customer_name?: string;
  waiting_list_entry_id?: string;
}

/** 403 BAR_CLOSED (no open cash session), 409 RESOURCE_OCCUPIED. */
export async function openTicket(body: OpenTicketBody): Promise<Ticket> {
  const { data } = await client.post<Ticket>('/tickets', body);
  return data;
}

export interface AddItemBody {
  menu_item_id: string;
  quantity: number;
  modifiers?: { modifier_id: string }[];
  notes?: string;
}

export interface AddItemOptions {
  /** Backend extension B1; harmlessly ignored by servers without it. */
  idempotencyKey?: string;
  /** Optimistic lock (409 VERSION_CONFLICT on mismatch). */
  ticketVersion?: number;
}

export async function addItem(ticketId: string, body: AddItemBody, opts: AddItemOptions = {}): Promise<TicketLineItem> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.ticketVersion != null) headers['X-Ticket-Version'] = String(opts.ticketVersion);
  const { data } = await client.post<TicketLineItem>(`/tickets/${ticketId}/items`, body, { headers });
  return data;
}

export async function requestPayment(ticketId: string): Promise<{ ok: boolean; total_cents: number }> {
  const { data } = await client.post<{ ok: boolean; total_cents: number }>(`/tickets/${ticketId}/request-payment`);
  return data;
}

/** Needs a manager PIN (401 INVALID_PIN). */
export async function voidItem(ticketId: string, itemId: string, pin: string, reason?: string): Promise<void> {
  await client.delete(`/tickets/${ticketId}/items/${itemId}`, { data: { pin, reason } });
}

/** Increase is free; decreasing needs a manager PIN (403 MANAGER_REQUIRED). */
export async function updateQty(ticketId: string, itemId: string, quantity: number, pin?: string): Promise<TicketLineItem> {
  const { data } = await client.patch<TicketLineItem>(`/tickets/${ticketId}/items/${itemId}`, { quantity, pin });
  return data;
}
