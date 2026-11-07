import client from '../client';
import type { Ticket } from '../../domain/types';

/** Row of GET /tickets/open-all (MANAGER/ADMIN only; 403 FORBIDDEN otherwise). */
export interface OpenTicketRow {
  id: string;
  resource_code: string | null;
  resource_status: string | null;
  customer_name: string | null;
  opened_at: string | null;
  item_count: number;
  total_cents: number;
}

export async function listOpenAll(): Promise<OpenTicketRow[]> {
  const { data } = await client.get<OpenTicketRow[]>('/tickets/open-all');
  return data;
}

/** OPEN tickets with "cuenta solicitada" (any authenticated role). */
export async function listPendingPayment(): Promise<Ticket[]> {
  const { data } = await client.get<Ticket[]>('/tickets/pending-payment');
  return data;
}
