import client from '../client';
import type { Ticket, TicketLineItem } from '../../domain/types';
import type { AddItemBody, AddItemOptions } from './tickets';

/** Add-item response. `ticket_version` is present only with backend extension B1 (feature detection). */
export interface AddItemResult extends TicketLineItem {
  ticket_version?: number;
  client_request_id?: string | null;
}

/** POST /tickets/:id/items -> 201 (new) or 200 (B1 replay of the same Idempotency-Key). */
export async function addItemIdem(ticketId: string, body: AddItemBody, opts: AddItemOptions = {}): Promise<AddItemResult> {
  const headers: Record<string, string> = {};
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  if (opts.ticketVersion != null) headers['X-Ticket-Version'] = String(opts.ticketVersion);
  const { data } = await client.post<AddItemResult>(`/tickets/${ticketId}/items`, body, { headers });
  return data;
}

/** OPEN tickets whose bill was requested (pool tables are AVAILABLE again while these stay OPEN). */
export async function listPendingPayment(): Promise<Ticket[]> {
  const { data } = await client.get<Ticket[]>('/tickets/pending-payment');
  return data;
}

/** 422 HAS_ITEMS / HAS_POOL_TIME when the ticket is not empty. */
export async function cancelTicket(ticketId: string): Promise<void> {
  await client.post(`/tickets/${ticketId}/cancel`);
}

export async function setCustomerName(ticketId: string, customerName: string): Promise<Ticket> {
  const { data } = await client.patch<Ticket>(`/tickets/${ticketId}/customer-name`, { customer_name: customerName });
  return data;
}

/** 409 RESOURCE_OCCUPIED when the target is taken. */
export async function transferTicket(ticketId: string, targetResourceId: string): Promise<Ticket> {
  const { data } = await client.post<Ticket>(`/tickets/${ticketId}/transfer`, { target_resource_id: targetResourceId });
  return data;
}

/** MANAGER/ADMIN JWT only (403 FORBIDDEN otherwise). */
export async function setDiscount(ticketId: string, pct: number, reason?: string): Promise<Ticket> {
  const { data } = await client.patch<Ticket>(`/tickets/${ticketId}/discount`, { pct, reason });
  return data;
}

/** Pre-bill print. 503 when the print agent is down. */
export async function printPreBill(ticketId: string): Promise<{ ok: boolean; job_id?: string }> {
  const { data } = await client.post<{ ok: boolean; job_id?: string }>(`/tickets/${ticketId}/print`, {}, { params: { unpaid: true } });
  return data;
}
